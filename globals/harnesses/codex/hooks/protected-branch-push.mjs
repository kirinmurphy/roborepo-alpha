import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Decides agent `git push` commands. Codex and Gemini keep `git push` at "ask"; Claude renders no
// rule for it, because an ask rule would outrank this hook's allow, so here this hook alone asks
// about a push it cannot verify. A permission prefix rule cannot tell pushes apart: `git push` on main, `git push origin HEAD:main`, and
// `git push origin :main` all start with the same words as a feature-branch push.
//
// Protected: main, master, the remote's default branch (refs/remotes/<remote>/HEAD), any names in
// ROBOREPO_PROTECTED_BRANCHES (comma-separated), and repo-plans, the plans store branch, which only
// `roborepo plans` commands push. A push that lands on one is denied, and so is any
// force push (a force option or a `+` refspec). A push this parser cannot pin down (--all, --mirror,
// shell expansion, globbed or configured refspecs, an unknown remote default branch) asks.
//
// A push it has verified is allowed, which is what lets agents push without a prompt. It allows only
// when the whole command is pushes (and `cd`), so the approval never covers anything chained on, and
// only when the git pre-push backstop is installed. The allow therefore exists only where both guards
// do: an install without this hook, or without the backstop, keeps the permission prompt.
//
// This reads the command text, so it can be fooled by indirection it cannot see (an alias, a
// script). The pre-push hook in ../git-hooks/ is the backstop: git hands it the exact refs.
//
// It also denies the gh commands that act on GitHub without git (API calls, the token, settings,
// merging a pull request) in the forms the permission prefix rules miss: global flags before the
// subcommand, as in `gh -R owner/repo pr merge …`. Those never reach either protected-branch guard.
//
// In a checkout that has a protected branch checked out, it denies git merge, pull, rebase,
// cherry-pick, and am, so agents never merge into it. A fast-forward-only pull or merge of the branch's own
// upstream, and stopping one in progress, stay allowed.
//
// It also guards a checkout that has a protected branch checked out against deletes. Claude's shell
// sandbox runs commands that stay inside the checkout and temp folders without a prompt, and the
// delete-files rule allows rm, so nothing else stops an agent working on main from deleting files
// or discarding work there. A delete (rm, rmdir, unlink, find -delete, xargs rm, git rm, git clean
// -f, git reset --hard, git restore of the working tree, git stash drop/clear) asks when its target
// is in such a checkout. Temp-folder targets and checkouts on any other branch are left alone, and
// so is anything this parser cannot see (a script, mv over a file, a redirect).
//
// The same file is installed for Claude and Codex; both send PreToolUse input on stdin and accept
// hookSpecificOutput.permissionDecision. Keep the two copies identical.
//
// Codex runs a command whose hook result is "ask" without prompting, so under Codex every ask
// becomes a deny. The copy knows it is Codex's from where it lives: <codex home>/hooks/, both
// installed (~/.codex/hooks) and in this repo (globals/harnesses/codex/hooks). The hooks.json
// command carries no flag for it because Codex trusts a hook by its exact definition, and a changed
// command would switch the guard off until the user reviewed it again.

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'bash'])
const SHELLS = new Set(['sh', 'bash', 'zsh'])
// git push options that take their value as the next word.
const VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const UNCLASSIFIABLE_OPTIONS = new Set(['--all', '--branches', '--mirror'])
// Skips the pre-push backstop, so a push carrying it is never allowed without a prompt.
const SKIPS_BACKSTOP = new Set(['--no-verify'])
// `roborepo plans` pushes this branch with Git hooks off, so a push that reaches either guard is a
// hand-made one.
const PLANS_STORE_BRANCH = 'repo-plans'

const VERIFIED = { decision: 'allow', reason: 'roborepo: push to a non-protected branch, checked by the protected-branch hooks.' }
// Git hosts whose CLI can act on the host without going through git, so the push guards cannot check
// it: one entry per forge provider, keyed by its id. Hooks import only Node built-ins, so this table
// mirrors each provider's manifest (modules/forge/providers/<id>/provider.json): `cli`,
// `identityVariables`, `configDirVariable`, `tokenVariables`, and `configSubfolder` equal its `cli.*`
// values, `packageId` and `stateFolder` its `agent.*` values, and `displayName` its own; a check
// (forge-provider-parity-check.mjs) keeps them equal. `denied` lists the command prefixes denied,
// `allowedAsAgent` the ones lifted while the shell runs as the provider's agent identity (see
// agentIdentityActive), and `liftRefusal` what still refuses a lifted command. The `github` denied
// list covers the change-github-directly and merge-pull-requests behaviors in
// agent-permissions.json; a test keeps the first equal to this list.
const HOST_CLIS = {
  github: {
    cli: 'gh',
    displayName: 'GitHub',
    identityVariables: ['GH_CONFIG_DIR', 'GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'GITHUB_ENTERPRISE_TOKEN', 'GH_HOST'],
    configDirVariable: 'GH_CONFIG_DIR',
    tokenVariables: ['GH_TOKEN', 'GITHUB_TOKEN'],
    packageId: 'github-agent-identity',
    stateFolder: 'github-agent',
    configSubfolder: 'gh',
    // gh options that take their value as the next word, before or between subcommands.
    valueOptions: ['-R', '--repo', '--hostname'],
    denied: [
      ['api'], ['auth', 'token'], ['pr', 'merge'], ['repo', 'edit'], ['repo', 'delete'], ['repo', 'rename'],
      ['secret'], ['variable'], ['release'], ['workflow', 'run'],
    ],
    allowedAsAgent: [['api']],
    // `gh api` stays refused, even as the bot, for a merge, an Authorization header, or GraphQL read
    // from a file (see apiLiftRefusal and apiOperationRefusal).
    liftRefusal: (args, expands) => apiLiftRefusal(args) ?? apiOperationRefusal(args, expands),
  },
}
const HOST_CLI_ENTRIES = Object.values(HOST_CLIS)
const hostCliFor = (program) => HOST_CLI_ENTRIES.find((entry) => entry.cli === program) ?? null
// Variables that choose which account or host any provider's CLI acts as.
const ALL_IDENTITY_VARIABLES = [...new Set(HOST_CLI_ENTRIES.flatMap((entry) => entry.identityVariables))]
// Set from the whole command before it is walked (see changesHostIdentity).
let hostIdentityChanged = false
// True when the entry's CLI in this shell acts as that provider's agent identity. Acting as the bot,
// the host's rules (GitHub's rulesets) and the bot's collaborator role limit what a lifted command
// (`gh api`) can do; as the user, it could rewrite main. It takes all three: the provider package's
// Git config file is installed, this hook's own config dir variable (GH_CONFIG_DIR) names the
// identity's config dir, and the command does not change any CLI's identity itself.
// Claude hooks share the session's environment, so an unset config dir variable means a session
// started before the identity was on, whose CLI acts as the user: it must match exactly. Codex starts
// command hooks with its own process environment, not the shell_environment_policy values its shells
// get, so under Codex an unset config dir variable is expected, and the hook reads those values from
// Codex's config instead (codexShellsActAsBot).
function agentIdentityActive(entry) {
  if (hostIdentityChanged) return false
  const stateRoot = process.env.ROBOREPO_STATE_ROOT || path.join(os.homedir(), '.roborepo')
  if (!fs.existsSync(path.join(stateRoot, 'package-runtime', entry.packageId, 'gitconfig'))) return false
  // The CLI prefers a token or host from the environment over its config dir, so an inherited one
  // means it acts as whoever owns that token.
  if (entry.identityVariables.some((name) => name !== entry.configDirVariable && process.env[name])) return false
  const botDir = path.join(stateRoot, entry.stateFolder, entry.configSubfolder)
  if (forCodex && !codexShellsActAsBot(entry, botDir, { userConfigRequired: !process.env[entry.configDirVariable] })) return false
  const dir = process.env[entry.configDirVariable]
  if (!dir) return forCodex
  return path.resolve(dir) === path.resolve(botDir)
}
const anyAgentIdentityActive = () => HOST_CLI_ENTRIES.some((entry) => agentIdentityActive(entry))

// Whether Codex gives its shells the entry's bot. Its user config's [shell_environment_policy.set]
// table must set the config dir variable (GH_CONFIG_DIR) to the bot's dir and empty the token
// variables (GH_TOKEN and GITHUB_TOKEN; required when the hook has no config dir variable of its
// own), and no layer Codex puts above that file may set any of the entry's identity variables to
// anything else. The package's gitconfig alone is not enough: an enable that
// could not set GH_CONFIG_DIR (one the user set themselves) still installs it, and gh in those shells
// acts as the user. The user config is the one beside this hook's folder (~/.codex/hooks ->
// ~/.codex), or CODEX_HOME's. Anything unreadable reads as no: a layer file or the profile folder
// that exists but cannot be read, or a layer the line reader cannot follow. `-c` overrides on Codex's
// own command line never reach a hook, so a session started with `-c shell_environment_policy...`
// can still give its shells another gh; that is a known limit of this check.
function codexShellsActAsBot(entry, botDir, { userConfigRequired }) {
  const codexHome = process.env.CODEX_HOME || path.dirname(hookDir)
  const userFile = path.join(codexHome, 'config.toml')
  const user = readCodexLayer(userFile, entry, botDir)
  if (user === null ? userConfigRequired : !user.keepsBot) return false
  if (userConfigRequired) {
    const dir = user.set.get(entry.configDirVariable)
    if (!dir || path.resolve(dir) !== path.resolve(botDir) || entry.tokenVariables.some((name) => user.set.get(name) !== '')) return false
  }
  const layers = codexOverrideLayers(codexHome, userFile)
  if (!layers) return false
  return layers.every((file) => {
    const layer = readCodexLayer(file, entry, botDir)
    return layer === null || layer.keepsBot
  })
}

// The Codex config files that sit above the user config and can change what its shells get:
// - a project's .codex/config.toml in the session's folder or any folder above it. Codex reads the
//   trusted ones from the project root down; this reads every one up to /, trusted or not.
// - each profile file a `--profile` can layer on (<codex home>/<name>.config.toml). Which one is
//   active is not known here, so every one must keep the bot. Profiles written as [profiles.<name>]
//   tables inside a config file are checked by readCodexLayer.
// - the managed config an administrator installs.
// `-c` overrides on Codex's own command line cannot be seen. null when the codex home exists but
// cannot be listed, since a profile in it could not be checked.
const CODEX_MANAGED_CONFIG = '/etc/codex/managed_config.toml'
let sessionFolders = []
function codexOverrideLayers(codexHome, userFile) {
  const files = new Set([CODEX_MANAGED_CONFIG])
  try {
    for (const name of fs.readdirSync(codexHome)) if (name.endsWith('.config.toml')) files.add(path.join(codexHome, name))
  } catch (error) {
    if (!isMissing(error)) return null
  }
  for (const start of sessionFolders) {
    for (let dir = path.resolve(start); ; dir = path.dirname(dir)) {
      files.add(path.join(dir, '.codex', 'config.toml'))
      if (dir === path.dirname(dir)) break
    }
  }
  const user = realFile(userFile)
  return [...files].filter((file) => realFile(file) !== user)
}
function realFile(file) {
  try {
    return fs.realpathSync(file)
  } catch {
    return path.resolve(file)
  }
}

// One Codex config file read line by line, without a TOML parser (hooks use only Node built-ins):
// `set` holds the plain entries of its [shell_environment_policy.set] table, and `keepsBot` is false
// when anything in it could give the shells another identity for the entry's CLI:
// - one of the entry's identity variables named anywhere Codex reads shell settings from (the top
//   level, a shell_environment_policy table, a profile) other than as a plain
//   [shell_environment_policy.set] entry holding the bot's value: the bot's dir for the config dir
//   variable (GH_CONFIG_DIR), empty for the rest;
// - a backslash there in a key, or in a shell_environment_policy or profile line, since an escape can
//   spell one of those names;
// - include_only, which can drop the config dir variable after it is set;
// - a line the reader cannot follow: a string left open at the end of its line, or one left open at
//   the end of the file.
// Comments are dropped first, outside strings only, so `# """` opens nothing. Lines inside multi-line
// strings are text, not settings. null when the file does not exist; one that exists but cannot be
// read keeps nothing.
const identityNamePattern = (names) => new RegExp(`(?<![A-Za-z0-9_])(?:${names.join('|')})(?![A-Za-z0-9_])`)
const ANY_IDENTITY_NAME = identityNamePattern(ALL_IDENTITY_VARIABLES)
const SET_TABLE = 'shell_environment_policy.set'
function readCodexLayer(file, cli, botDir) {
  const identityName = identityNamePattern(cli.identityVariables)
  let text
  try {
    text = fs.readFileSync(file, 'utf8')
  } catch (error) {
    return isMissing(error) ? null : { set: new Map(), keepsBot: false }
  }
  const set = new Map()
  let keepsBot = true
  let table = ''
  let multiline = null
  for (const raw of text.split(/\r?\n/)) {
    const scanned = tomlLineCode(raw, multiline)
    multiline = scanned.multiline
    if (scanned.unreadable) keepsBot = false
    const line = scanned.code
    if (/^\s*$/.test(line)) continue
    const header = /^\s*\[\[?([^\]]*)\]\]?\s*(?:#.*)?$/.exec(line)
    if (header) {
      if (header[1].includes('\\')) keepsBot = false
      table = header[1].replace(/[\s"']/g, '')
      continue
    }
    const readsShell = table === '' || table.startsWith('profiles') || table.includes('shell_environment_policy')
    if (!readsShell) continue
    const entry = table === SET_TABLE && /^\s*"?([A-Za-z_][A-Za-z0-9_]*)"?\s*=\s*"([^"\\]*)"\s*(?:#.*)?$/.exec(line)
    if (entry) {
      set.set(entry[1], entry[2])
      if (cli.identityVariables.includes(entry[1])) {
        const bots = entry[1] === cli.configDirVariable ? entry[2] !== '' && path.resolve(entry[2]) === path.resolve(botDir) : entry[2] === ''
        if (!bots) keepsBot = false
      }
      continue
    }
    const key = line.split('=')[0]
    if (identityName.test(line) || /\binclude_only\b/.test(line) || key.includes('\\')
      || (line.includes('\\') && (table !== '' || /shell_environment_policy|profiles/.test(line)))) keepsBot = false
  }
  if (multiline) keepsBot = false
  return { set, keepsBot }
}

// One TOML line with its comment removed, read from the `multiline` string state the line before
// left (null, or the open """ or ''' delimiter). Strings are kept as written; a line that starts
// inside a multi-line string keeps only what follows its closing delimiter. `unreadable` marks a
// single-line string still open at the end of the line, which TOML does not allow.
function tomlLineCode(line, multiline) {
  let start = 0
  let i = 0
  if (multiline) {
    const close = closingDelimiter(line, 0, multiline)
    if (close === -1) return { code: '', multiline, unreadable: false }
    i = start = close
    multiline = null
  }
  while (i < line.length) {
    const ch = line[i]
    if (ch === '#') break
    if (ch === '"' || ch === "'") {
      const triple = ch.repeat(3)
      if (line.startsWith(triple, i)) {
        const close = closingDelimiter(line, i + 3, triple)
        if (close === -1) return { code: line.slice(start), multiline: triple, unreadable: false }
        i = close
        continue
      }
      let j = i + 1
      while (j < line.length && line[j] !== ch) j += ch === '"' && line[j] === '\\' ? 2 : 1
      if (j >= line.length) return { code: line.slice(start), multiline: null, unreadable: true }
      i = j + 1
      continue
    }
    i += 1
  }
  return { code: line.slice(start, i), multiline: null, unreadable: false }
}
// Where the multi-line string `delimiter` closes in `line`, searching from `from`: the index after its
// closing quotes (TOML lets up to two more quotes end the string's text), or -1 when it stays open.
// A basic string's backslash escapes the next character.
function closingDelimiter(line, from, delimiter) {
  for (let i = from; i < line.length; i += 1) {
    if (delimiter === '"""' && line[i] === '\\') {
      i += 1
      continue
    }
    if (line.startsWith(delimiter, i)) {
      let end = i + 3
      while (end < line.length && end < i + 5 && line[end] === delimiter[0]) end += 1
      return end
    }
  }
  return -1
}
function isMissing(error) {
  return error?.code === 'ENOENT' || error?.code === 'ENOTDIR'
}

// Whether any command in `text`, nested ones included, could make a provider's CLI act as someone
// other than the identity: it assigns, exports, unsets, or otherwise names one of any entry's
// identity variables (`GH_TOKEN=x gh api`, `export GH_TOKEN+=x`, `unset GH_CONFIG_DIR`,
// `env -u GH_CONFIG_DIR`), or runs a provider's CLI through `env`.
function changesHostIdentity(text) {
  const names = ALL_IDENTITY_VARIABLES.join('|')
  const namesVariable = new RegExp(`^(?:--unset=|-u)?(?:${names})(?:\\+?=|$)|\\$\\{(?:${names}):?=`)
  const clis = new Set(HOST_CLI_ENTRIES.map((entry) => entry.cli))
  for (const words of splitCommands(exposeNestedCommands(withoutComments(text)))) {
    if (words.some((word) => namesVariable.test(word))) return true
    const cli = words.findIndex((word) => clis.has(path.basename(word)))
    if (cli > 0 && words.slice(0, cli).some((word) => path.basename(word) === 'env')) return true
    if (nestedScripts(words).some((script) => changesHostIdentity(script))) return true
  }
  return false
}
// A `codex` command line whose `-c`/`--config` override touches the shell environment Codex hands its
// shells, or names a provider CLI's identity variable. Hooks never see such overrides, so the session
// it starts could give `gh` another account while its own hook lifts the `gh api` denial.
function codexIdentityOverride(args) {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]
    let value = null
    if (arg === '-c' || arg === '--config') value = args[k + 1] ?? ''
    else if (arg.startsWith('--config=')) value = arg.slice('--config='.length)
    else if (/^-c./.test(arg)) value = arg.slice(2)
    if (value !== null && (/shell_environment_policy/.test(value) || ANY_IDENTITY_NAME.test(value))) return true
  }
  return false
}

const hookDir = path.dirname(fileURLToPath(import.meta.url))
const gitHooksDir = process.env.ROBOREPO_GIT_HOOKS_DIR || path.join(hookDir, '..', 'git-hooks')
const forCodex = ['.codex', 'codex'].includes(path.basename(path.dirname(hookDir)))

function readHookInput() {
  try {
    return JSON.parse(fs.readFileSync(0, 'utf8'))
  } catch {
    return null
  }
}

// The character a `$'…'` escape stands for, and how many characters of `text` after the backslash
// it used. Unknown escapes keep their backslash, as bash does.
const ANSI_C_ESCAPES = { a: '\x07', b: '\b', e: '\x1b', E: '\x1b', f: '\f', n: '\n', r: '\r', t: '\t', v: '\v', '\\': '\\', "'": "'", '"': '"', '?': '?' }
function ansiCEscape(text, i) {
  const ch = text[i]
  if (ch in ANSI_C_ESCAPES) return [ANSI_C_ESCAPES[ch], 1]
  const coded = /^(?:x([0-9A-Fa-f]{1,2})|u([0-9A-Fa-f]{1,4})|U([0-9A-Fa-f]{1,8})|([0-7]{1,3}))/.exec(text.slice(i))
  if (coded) {
    const hex = coded[1] ?? coded[2] ?? coded[3]
    const point = hex ? parseInt(hex, 16) : parseInt(coded[4], 8)
    return [point <= 0x10ffff ? String.fromCodePoint(point) : '', coded[0].length]
  }
  return [`\\${ch ?? ''}`, ch === undefined ? 0 : 1]
}

// Splits a shell command into simple commands (word lists), honoring quotes, including `$'…'`
// with its escapes. Separators are ; & | && || and newlines; a backslash-newline joins lines. With
// `parens`, an unquoted `(` or `)` is a word of its own, so `(true; git push origin main)` reads
// `main` and not `main)`.
// Expansion is not performed; a word that still holds $ or a backtick is reported so the caller can
// decline to classify it. Each word list carries `expands`: per word, whether a $ or backtick in it
// sits outside single quotes (`'$x'` and `$'\x24x'` stay as written; `"$x"` and `$x` expand).
function splitCommands(text, { parens = false } = {}) {
  const commands = []
  let words = []
  let expands = []
  let word = null
  let expanding = false
  let quote = null
  const endWord = () => {
    if (word !== null) {
      words.push(word)
      expands.push(expanding)
    }
    word = null
    expanding = false
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(Object.assign(words, { expands }))
    words = []
    expands = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const opensQuote = quote === null && ch === '$' && (text[i + 1] === "'" || text[i + 1] === '"')
    if ((ch === '$' || ch === '`') && quote !== "'" && quote !== "$'" && !opensQuote) expanding = true
    if (quote === "'") {
      if (ch === "'") quote = null
      else word += ch
    } else if (quote === "$'") {
      if (ch === "'") quote = null
      else if (ch === '\\') {
        const [decoded, used] = ansiCEscape(text, i + 1)
        word += decoded
        i += used
      } else word += ch
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && text[i + 1] === '\n') i += 1
      // Inside double quotes a backslash escapes only $, `, ", \, and newline; before anything else
      // it stays, so `sh -c "echo a\ #b; …"` hands the inner shell an escaped blank, not a comment.
      else if (ch === '\\' && i + 1 < text.length && '$`"\\'.includes(text[i + 1])) word += text[++i]
      else word += ch
    } else if (ch === '$' && (text[i + 1] === "'" || text[i + 1] === '"')) {
      // `$'…'` is a quoted string with escapes, and `$"…"` a double-quoted one.
      quote = text[i + 1] === "'" ? "$'" : '"'
      word ??= ''
      i += 1
    } else if (ch === "'" || ch === '"') {
      quote = ch
      word ??= ''
    } else if (ch === '\\' && text[i + 1] === '\n') {
      i += 1
    } else if (ch === '\\' && i + 1 < text.length) {
      word = (word ?? '') + text[++i]
    } else if (ch === '&' && word !== null && /[<>]$/.test(word)) {
      word += ch // `2>&1`: a redirection, not a separator
    } else if (ch === ';' || ch === '&' || ch === '|' || ch === '\n') {
      endCommand()
    } else if (ch === ' ' || ch === '\t') {
      endWord()
    } else if (parens && (ch === '(' || ch === ')')) {
      endWord()
      words.push(ch)
      expands.push(false)
    } else {
      word = (word ?? '') + ch
    }
  }
  endCommand()
  return commands
}

// `text` without its comments, so an apostrophe in one opens no quote for the readers after it. A
// `#` starts a comment where bash starts one: at the start of a word, after an unquoted, unescaped
// blank or `;&|<>(`, or after a `)` that closes a subshell or case pattern. A `)` closing `$(…)`,
// `<(…)`, or a group inside a word (`@(x)`) continues the word. It is text inside quotes, `${…}`,
// `$((…))`, and `[[ … ]]`. A comment runs to the newline, or to the backtick that closes the
// substitution it is in. Heredoc bodies are copied unread: they are not shell to this reader. When the
// quotes do not balance, the text is returned as it is, so a misread can only leave a comment in.
function withoutComments(text) {
  if (!text.includes('#')) return text
  let out = ''
  const open = [] // ' $' " ${ $( $(( <( ( (g `
  let wordStart = true
  let inBrackets = false
  let heredocs = []
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const top = open.at(-1)
    const quoted = top === "'" || top === "$'" || top === '"'
    if (ch === '\n' && heredocs.length && !quoted) {
      out += ch
      const bodiesStart = out.length
      let pos = i + 1
      for (const [index, { delimiter, stripTabs }] of heredocs.entries()) {
        let found = false
        while (pos <= text.length) {
          const next = text.indexOf('\n', pos)
          const lineEnd = next === -1 ? text.length : next
          const line = text.slice(pos, lineEnd)
          out += line
          pos = lineEnd
          if ((stripTabs ? line.replace(/^\t+/, '') : line) === delimiter) {
            found = true
            break
          }
          if (lineEnd === text.length) break
          out += '\n'
          pos += 1
        }
        if (!found) {
          // No closing line (a caller already took the body out): read on as ordinary text.
          out = out.slice(0, bodiesStart)
          pos = i + 1
          break
        }
        if (index < heredocs.length - 1 && text[pos] === '\n') {
          out += '\n'
          pos += 1
        }
      }
      heredocs = []
      i = pos - 1
      wordStart = true
      continue
    }
    if (top === "'" || top === "$'") {
      if (top === "$'" && ch === '\\' && i + 1 < text.length) {
        out += ch + text[++i]
        continue
      }
      if (ch === "'") open.pop()
      out += ch
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[++i]
      wordStart = false
      continue
    }
    if (ch === '#' && wordStart && !inBrackets && top !== '"' && top !== '${' && top !== '$((') {
      let end = text.indexOf('\n', i)
      if (end === -1) end = text.length
      const tick = top === '`' ? text.indexOf('`', i) : -1
      if (tick !== -1 && tick < end) end = tick
      i = end - 1
      continue
    }
    if (ch === '$' && text.startsWith('$((', i)) {
      open.push('$((')
      out += '$(('
      i += 2
      wordStart = false
      continue
    }
    if (ch === '$' && (text[i + 1] === '(' || text[i + 1] === '{' || (text[i + 1] === "'" && top !== '"'))) {
      open.push(`$${text[i + 1]}`)
      out += ch + text[i + 1]
      i += 1
      wordStart = text[i] === '('
      continue
    }
    if (top === '$((' && ch === ')' && text[i + 1] === ')') {
      open.pop()
      out += '))'
      i += 1
      wordStart = false
      continue
    }
    if (top === '"') {
      if (ch === '"') open.pop()
      else if (ch === '`') open.push('`')
      out += ch
      wordStart = false
      continue
    }
    if (ch === '<' && text[i + 1] === '<' && text[i + 2] !== '<' && top !== '${' && top !== '$((') {
      // A heredoc: its body starts after the next newline and is copied unread.
      let k = i + 2
      const stripTabs = text[k] === '-'
      if (stripTabs) k += 1
      while (text[k] === ' ' || text[k] === '\t') k += 1
      let delimiter = ''
      for (; k < text.length && !/[\s;&|<>()]/.test(text[k]); k += 1) {
        if (text[k] === '\\' && k + 1 < text.length) delimiter += text[++k]
        else if (text[k] !== "'" && text[k] !== '"') delimiter += text[k]
      }
      if (delimiter) heredocs.push({ delimiter, stripTabs })
      out += text.slice(i, k)
      i = k - 1
      wordStart = false
      continue
    }
    if (ch === '[' && wordStart && text.startsWith('[[', i) && /\s/.test(text[i + 2] ?? '')) {
      inBrackets = true
      out += '[['
      i += 1
      wordStart = false
      continue
    }
    if (ch === ']' && inBrackets && wordStart && text[i + 1] === ']') {
      inBrackets = false
      out += ']]'
      i += 1
      wordStart = false
      continue
    }
    out += ch
    if (ch === "'" || ch === '"') {
      open.push(ch)
      wordStart = false
    } else if (ch === '`') {
      if (top === '`') {
        open.pop()
        wordStart = false
      } else {
        open.push('`')
        wordStart = true
      }
    } else if (ch === '}' && top === '${') {
      open.pop()
      wordStart = false
    } else if (ch === ')' && (top === '$(' || top === '<(' || top === '(g')) {
      open.pop()
      wordStart = false
    } else if (ch === ')') {
      if (top === '(') open.pop()
      wordStart = !inBrackets
    } else if (ch === '(') {
      if (top === '${' || top === '$((') {
        // arithmetic or expansion text
      } else if (text[i - 1] === '<' || text[i - 1] === '>') open.push('<(')
      else open.push(wordStart ? '(' : '(g')
      wordStart = true
    } else {
      wordStart = /[\s;&|<>]/.test(ch)
    }
  }
  return open.some((q) => q === "'" || q === "$'" || q === '"') ? text : out
}

function git(cwd, args) {
  try {
    return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000 }).trim()
  } catch {
    return ''
  }
}

// `defaultKnown` is false when no refs/remotes/<remote>/HEAD is recorded (a remote added but never
// fetched, or a push to a URL): the remote's default branch is then unknown, and this hook has no
// network access to ask the remote.
function protectedBranches(cwd, remote) {
  const names = new Set(['main', 'master', PLANS_STORE_BRANCH])
  for (const name of (process.env.ROBOREPO_PROTECTED_BRANCHES || '').split(',')) {
    if (name.trim()) names.add(name.trim())
  }
  const remoteHead = git(cwd, ['symbolic-ref', '--quiet', '--short', `refs/remotes/${remote}/HEAD`])
  const defaultKnown = remoteHead.startsWith(`${remote}/`)
  if (defaultKnown) names.add(remoteHead.slice(remote.length + 1))
  return { names, defaultKnown }
}

function backstopInstalled() {
  try {
    fs.accessSync(path.join(gitHooksDir, 'pre-push'), fs.constants.X_OK)
    return true
  } catch {
    return false
  }
}

function currentBranch(cwd) {
  return git(cwd, ['symbolic-ref', '--quiet', '--short', 'HEAD'])
}

function defaultRemote(cwd, branch) {
  return (branch && (git(cwd, ['config', `branch.${branch}.pushRemote`]) || git(cwd, ['config', `branch.${branch}.remote`])))
    || git(cwd, ['config', 'remote.pushDefault'])
    || 'origin'
}

// The branch a refspec writes to on the remote, or null when it writes no branch (a tag, a
// non-branch ref). `deleting` marks the `:branch` form.
function refspecDestination(cwd, refspec) {
  const spec = refspec.replace(/^\+/, '')
  const colon = spec.indexOf(':')
  const src = colon === -1 ? spec : spec.slice(0, colon)
  let dst = colon === -1 || colon === spec.length - 1 ? src : spec.slice(colon + 1)
  if (dst === 'HEAD' || dst === '@') dst = currentBranch(cwd)
  if (dst.startsWith('refs/heads/')) dst = dst.slice('refs/heads/'.length)
  else if (dst.startsWith('refs/')) return null
  return { branch: dst, deleting: colon === 0 }
}

// Where a bare `git push [remote]` writes: @{push} is git's own answer for the current branch.
function implicitDestination(cwd) {
  const pushRef = git(cwd, ['rev-parse', '--abbrev-ref', '--symbolic-full-name', '@{push}'])
  const slash = pushRef.indexOf('/')
  return slash === -1 ? currentBranch(cwd) : pushRef.slice(slash + 1)
}

// A force option in any spelling: --force, --force-with-lease[=...], or a short cluster holding f
// (-f, -uf). Letters after o are -o's value, not options.
function isForceOption(arg) {
  if (arg === '--force' || arg === '--force-with-lease' || arg.startsWith('--force-with-lease=')) return true
  const cluster = /^-([A-Za-z]+)$/.exec(arg)?.[1]
  return Boolean(cluster) && cluster.split('o')[0].includes('f')
}

// Returns { decision, reason } for a `git push` word list (words after `push`): VERIFIED for a push
// that lands only on non-protected branches, or null to stay out.
function classifyPush(cwd, args) {
  const end = args.indexOf('--')
  const options = end === -1 ? args : args.slice(0, end)
  const forceOption = options.find(isForceOption)
  if (forceOption) return denyForce(`\`${forceOption}\``)

  const words = []
  let remote = null
  let deleteFlag = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (/^[0-9]?>&[0-9]$/.test(arg)) continue // 2>&1 only merges output streams
    if (/[$`]/.test(arg)) return ask(`cannot tell where this push lands: \`${arg}\` is expanded by the shell`)
    if (arg === '--') {
      words.push(...args.slice(i + 1))
      break
    }
    if (UNCLASSIFIABLE_OPTIONS.has(arg)) return ask(`\`git push ${arg}\` can include a protected branch`)
    if (SKIPS_BACKSTOP.has(arg)) return ask(`\`${arg}\` skips the pre-push check`)
    // A redirect (`2>/dev/null`, `> out.log`) changes nothing about where the push lands.
    const redirect = /^(\d*|&)(>>?|<)(.*)$/.exec(arg)
    if (redirect) {
      if (redirect[3] === '') i += 1
      continue
    }
    if (/[<>]/.test(arg)) return ask(`cannot tell where this push lands: \`${arg}\``)
    if (arg === '--delete' || arg === '-d') deleteFlag = true
    else if (arg.startsWith('--repo=')) remote = arg.slice('--repo='.length)
    else if (VALUE_OPTIONS.has(arg)) {
      if (arg === '--repo') remote = args[i + 1]
      i += 1
    } else if (!arg.startsWith('-')) words.push(arg)
  }

  remote ??= words.shift() ?? null
  const forcedRefspec = words.find((word) => word.startsWith('+'))
  if (forcedRefspec) return denyForce(`refspec \`${forcedRefspec}\``)
  const branch = currentBranch(cwd)
  remote ??= defaultRemote(cwd, branch)
  const { names: protectedNames, defaultKnown } = protectedBranches(cwd, remote)
  const mapped = Boolean(git(cwd, ['config', '--get-all', `remote.${remote}.push`]))

  if (words.length === 0) {
    if (deleteFlag) return ask('`git push --delete` with no branch named')
    if (git(cwd, ['config', 'push.default']) === 'matching') return ask('push.default is "matching", which can include a protected branch')
    if (mapped) return ask(`remote.${remote}.push is configured; cannot tell where this push lands`)
    const target = implicitDestination(cwd)
    if (target && protectedNames.has(target)) return deny(target, `\`git push\` from ${branch || 'this branch'} writes to ${remote}/${target}`)
    return defaultKnown ? VERIFIED : unknownDefault(remote)
  }

  const deleted = []
  for (const refspec of words) {
    if (refspec.includes('*')) return ask(`refspec \`${refspec}\` is a pattern and can include a protected branch`)
    if (refspec === ':') return ask('refspec `:` pushes every branch that also exists on the remote')
    if (mapped && !deleteFlag && !refspec.includes(':')) return ask(`remote.${remote}.push is configured, so \`${refspec}\` may not land on a branch of that name`)
    const destination = deleteFlag ? { branch: refspec.replace(/^refs\/heads\//, ''), deleting: true } : refspecDestination(cwd, refspec)
    if (destination && protectedNames.has(destination.branch)) {
      const verb = destination.deleting ? 'deletes' : 'writes to'
      return deny(destination.branch, `\`${refspec}\` ${verb} ${remote}/${destination.branch}`)
    }
    if (destination?.deleting) deleted.push(destination.branch)
  }
  // Deleting a remote branch is never approved silently, even one that is not protected.
  if (deleted.length) return ask(`this push deletes ${deleted.join(', ')} from ${remote}`)
  return defaultKnown ? VERIFIED : unknownDefault(remote)
}

// REST paths and GraphQL mutations that merge. Agents never merge (merge-pull-requests), and the
// bot's write role lets it merge an approved pull request, so the agent lift keeps these denied.
// They are matched against the operation only (the REST endpoint, or the GraphQL query), never the
// data a call sends, so a review reply that mentions `mergePullRequest` is not a merge.
const REST_MERGES = /(?:^|\/)pulls\/[^/\s]+\/merge\b|(?:^|\/)merges\b|(?:^|\/)merge-upstream\b/
const GRAPHQL_MERGES = /\b(?:mergePullRequest|enablePullRequestAutoMerge|enqueuePullRequest|mergeBranch)\b/
// `gh api` options that take their value as the next word, and the short ones that take the rest of
// their cluster (`-XPUT`, `-iH 'Accept: x'`).
const GH_API_VALUE_OPTIONS = new Set(['-X', '--method', '-H', '--header', '-f', '--raw-field', '-F', '--field', '-q', '--jq', '-t', '--template', '--input', '--hostname', '--cache', '-p', '--preview'])
const GH_API_SHORT_VALUES = 'XHfFqtp'

// Why the `gh api` call in `args` cannot keep the agent lift because of what it does, or null. It
// merges, or the operation cannot be read from the command `text`: an endpoint the shell fills in
// (`$EP`), or a GraphQL query that is missing or that the shell could change. A query may use GraphQL
// variables (`$id`) only when that argument's own `$` signs are inside single quotes, where the shell
// leaves them alone; `expands` says, per argument, whether one is not (see splitCommands).
function apiOperationRefusal(args, expands) {
  const { endpoint, queries } = apiOperation(args, expands)
  const unread = 'the hook cannot read which API operation this `gh api` call runs, so it cannot rule out a merge. Write the endpoint and any GraphQL query literally, or run it yourself.'
  const merges = '`gh api` merges here, and agents never merge. Run it yourself.'
  if (!endpoint || /[$`]/.test(endpoint)) return unread
  if (REST_MERGES.test(endpoint)) return merges
  if (!/(?:^|\/)graphql$/.test(endpoint.split('?')[0])) return null
  if (!queries.length) return unread
  for (const query of queries) {
    if (GRAPHQL_MERGES.test(query.text)) return merges
    if (query.expands) return unread
  }
  return null
}

// The endpoint and the `query` field values of a `gh api` call, from the gh arguments, each query
// with whether the shell expands anything in the argument it came from. An argument with no `expands`
// entry counts as expanding.
function apiOperation(args, expands) {
  let i = 0
  while (i < args.length && args[i] !== 'api') i += HOST_CLIS.github.valueOptions.includes(args[i]) ? 2 : 1
  let endpoint = null
  const queries = []
  let optionsEnded = false
  for (i += 1; i < args.length; i += 1) {
    const arg = args[i]
    let field = null
    let fieldAt = i
    if (optionsEnded || !arg.startsWith('-') || arg === '-') {
      endpoint ??= arg
    } else if (arg === '--') {
      optionsEnded = true
    } else if (arg === '-f' || arg === '-F' || arg === '--raw-field' || arg === '--field') {
      fieldAt = ++i
      field = args[i] ?? ''
    } else if (/^--(?:raw-)?field=/.test(arg)) {
      field = arg.slice(arg.indexOf('=') + 1)
    } else if (GH_API_VALUE_OPTIONS.has(arg)) {
      i += 1
    } else if (!arg.startsWith('--')) {
      // A short cluster: flags up to the first option that takes a value, which takes the rest.
      const at = [...arg.slice(1)].findIndex((letter) => GH_API_SHORT_VALUES.includes(letter))
      if (at !== -1) {
        const value = arg.slice(at + 2) || (args[(fieldAt = ++i)] ?? '')
        if ('fF'.includes(arg[at + 1])) field = value
      }
    }
    if (field?.startsWith('query=')) queries.push({ text: field.slice('query='.length), expands: expands[fieldAt] ?? true })
  }
  return { endpoint, queries }
}

// Why the agent lift does not apply to these `gh api` arguments, or null when it does. An explicit
// Authorization header replaces gh's configured token, so the call would act as whichever account
// that token belongs to; a header whose name cannot be read (`-H "$H"`) may be one. A GraphQL query
// read from a file or stdin (`-F query=@file`, `--input`) cannot be checked for a merge mutation.
const READABLE_HEADER = /^\s*([A-Za-z0-9-]+)\s*:/
function apiLiftRefusal(args) {
  const headers = []
  const fields = []
  let input = false
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i]
    if (arg === '-H' || arg === '--header') headers.push(args[++i] ?? '')
    else if (arg.startsWith('--header=')) headers.push(arg.slice('--header='.length))
    else if (/^-[A-Za-z]*H/.test(arg) && !arg.startsWith('--')) {
      const value = arg.slice(arg.indexOf('H') + 1)
      headers.push(value || (args[++i] ?? ''))
    } else if (arg === '-F' || arg === '--field') fields.push(args[++i] ?? '')
    else if (arg.startsWith('--field=')) fields.push(arg.slice('--field='.length))
    else if (/^-F./.test(arg)) fields.push(arg.slice(2))
    else if (arg === '--input' || arg.startsWith('--input=')) input = true
  }
  for (const header of headers) {
    const name = READABLE_HEADER.exec(header)?.[1]
    if (!name || name.toLowerCase() === 'authorization') {
      return '`gh api` with an Authorization header, or one whose name cannot be read, acts as whichever account that token belongs to instead of the bot. Run it yourself.'
    }
  }
  const graphql = args.some((arg) => /^\/?graphql$/.test(arg))
  if (graphql && (input || fields.some((field) => /^[^=]*=@/.test(field)))) {
    return 'a GraphQL query read from a file or stdin cannot be checked for a merge. Pass the query inline with `-f query=...`, or run it yourself.'
  }
  return null
}

// A provider's CLI with its options removed, matched against that entry's denied list.
// `expands` holds, per argument, whether the shell expands anything in it (see splitCommands).
function classifyHostCli(entry, args, expands) {
  const words = []
  for (let i = 0; i < args.length; i += 1) {
    if (entry.valueOptions.includes(args[i])) i += 1
    else if (!args[i].startsWith('-')) words.push(args[i])
  }
  const denied = entry.denied.find((prefix) => prefix.every((word, k) => words[k] === word))
  if (!denied) return null
  if (entry.allowedAsAgent.some((prefix) => prefix.join(' ') === denied.join(' ')) && agentIdentityActive(entry)) {
    const refusal = entry.liftRefusal(args, expands)
    if (!refusal) return null
    return { decision: 'deny', reason: `roborepo: ${refusal}` }
  }
  return {
    decision: 'deny',
    reason: `roborepo: \`${entry.cli} ${denied.join(' ')}\` acts on ${entry.displayName} without going through git, so the protected-branch guards cannot check it. Run it yourself.`,
  }
}

const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink'])
// Temp folders, where deletes never ask: the manifest's temporaryLocations, the one list agents'
// temporary files go to, each with a cleanup. TMPDIR covers a sandbox's per-session temp folder.
// ROBOREPO_TEMP_ROOTS (comma-separated) replaces the list.
const TEMP_ROOTS = [...new Set((process.env.ROBOREPO_TEMP_ROOTS
  ? process.env.ROBOREPO_TEMP_ROOTS.split(',')
  : [...manifestTemporaryLocations(), os.tmpdir(), process.env.TMPDIR])
  .map((root) => (root ?? '').trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .flatMap((root) => [root, realDirectory(root)]))]

// Every folder in temporaryLocations, whichever harness it is for: a folder is temporary or not
// regardless of who deletes in it. The manifest is found the way the repository-boundary hook finds
// it: an explicit REPO_ROOT, the app root the CLI records at install, the development installer's
// install state, then this file's own location walked back to the repository root. When none is
// readable the list is empty, so deletes outside TMPDIR are judged like any other path.
function manifestTemporaryLocations() {
  const readJson = (file) => {
    try {
      return JSON.parse(fs.readFileSync(file, 'utf8'))
    } catch {
      return null
    }
  }
  const home = os.homedir()
  const stateDir = process.env.ROBOREPO_STATE_ROOT || path.join(home, '.roborepo')
  const candidates = [
    process.env.REPO_ROOT,
    readJson(path.join(stateDir, 'app-root.json'))?.appRoot,
    readJson(path.join(stateDir, 'install-state.json'))?.repo,
    path.resolve(hookDir, '../../../..'),
  ].filter((root) => typeof root === 'string' && root)
  for (const root of candidates) {
    const locations = readJson(path.join(root, 'manifests', 'inventory', 'agent-permissions.json'))?.temporaryLocations
    if (!Array.isArray(locations)) continue
    return locations.flatMap((location) => location.paths ?? [])
      .map((folder) => (folder.startsWith('~/') ? path.join(home, folder.slice(2)) : folder))
  }
  return []
}
// Shell words that start a command without being its program.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'exec', 'command', 'builtin', 'nohup', 'nice', 'sudo', 'env'])
// Options of each wrapper that take the next word as their value; `command -p` takes none.
const WRAPPER_VALUE_OPTIONS = {
  sudo: new Set(['-u', '-g', '-C', '-p', '-r', '-t', '-h', '-U', '-D']),
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  nice: new Set(['-n', '--adjustment']),
  exec: new Set(['-a']),
  time: new Set(['-f', '-o', '--format', '--output']),
}
// xargs options that take the next word as their value.
const XARGS_VALUE_OPTIONS = new Set(['-n', '-I', '-i', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--replace'])
// How far below a deleted folder to look for a checkout on a protected branch.
const CONTAINED_CHECKOUT_DEPTH = 2
const checkoutCache = new Map()

// `dir` with symlinks resolved, or `dir` itself when it cannot be read.
function realDirectory(dir) {
  try {
    return fs.realpathSync(dir)
  } catch {
    return dir
  }
}

// The physical path the shell reaches through `raw`, an absolute path as written: each existing part
// is resolved through its symlink before the next `..` applies, the way the kernel walks it, so
// `/tmp/link/../x` and `/tmp/link/` reach what the link points to. With `keepLast`, a final part that
// is itself a symlink stays unresolved, because rm removes the link, not what it points to.
function physicalPath(raw, keepLast = false) {
  const parts = raw.split('/')
  const last = keepLast && !raw.endsWith('/') && !['.', '..'].includes(parts.at(-1)) ? parts.pop() : null
  let current = '/'
  for (const part of parts) {
    if (part === '' || part === '.') continue
    if (part === '..') {
      current = path.dirname(current)
      continue
    }
    const next = path.join(current, part)
    current = fs.existsSync(next) ? realDirectory(next) : next
  }
  return last === null ? current : path.join(current, last)
}

// Branches a `git switch` or `git checkout` earlier in the same command may move a checkout to, by its
// top folder. The hook runs before the command, so the checkout's own HEAD would be stale; and since
// a switch can fail (`git switch x; rm f`), the branch before it still counts too.
const branchChanges = new Map()
const UNKNOWN_BRANCH = '(a branch this hook cannot read)'

// `*` in a temp root stands for exactly one folder name: macOS keeps a temp folder per user at
// /private/var/folders/<xx>/<id>/T, beside cache folders that are not temporary.
function inTemp(target) {
  const have = target.split('/')
  return TEMP_ROOTS.some((root) => {
    const want = root.split('/')
    return have.length >= want.length && want.every((part, i) => (part === '*' ? have[i] !== '' : part === have[i]))
  })
}

// The checkout holding `dir` when it has a protected branch checked out, else null.
function checkoutAt(dir) {
  if (checkoutCache.has(dir) && !branchChanges.size) return checkoutCache.get(dir)
  let found = null
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  const branches = top ? [currentBranch(dir), ...(branchChanges.get(top) ?? [])].filter(Boolean) : []
  for (const branch of branches) {
    if (branch === UNKNOWN_BRANCH || protectedBranches(dir, defaultRemote(dir, branch)).names.has(branch)) {
      found = { top, branch }
      break
    }
  }
  if (!branchChanges.size) checkoutCache.set(dir, found)
  return found
}

// Records the branch `git switch` or `git checkout` moves the checkout at `dir` to. A file checkout
// (`git checkout -- x`, or a name that is no branch) changes nothing. A new branch (`-b`, `-c`,
// `--orphan`) is a branch by definition, and `--track origin/main` lands on `main`. A name the hook
// cannot read (`-`, `@{-1}`, a variable) counts as protected.
function recordBranchChange(dir, subcommand, args) {
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  if (!top || (subcommand === 'checkout' && args.includes('--'))) return
  const record = (branch) => branchChanges.set(top, new Set([...(branchChanges.get(top) ?? []), branch]))
  let target = null
  let created = false
  for (let k = 0; k < args.length; k += 1) {
    if (['-c', '-C', '-b', '-B', '--create', '--force-create', '--orphan'].includes(args[k])) {
      target = args[k + 1] ?? null
      created = true
      break
    }
    const attached = /^(?:-[cCbB]|--(?:create|force-create|orphan)=)(.+)$/.exec(args[k])
    if (attached) {
      target = attached[1]
      created = true
      break
    }
    if (args[k] === '-' || !args[k].startsWith('-')) {
      target = args[k]
      break
    }
  }
  if (target === null) return
  if (target === '-' || /[$`]|@\{/.test(target)) {
    record(UNKNOWN_BRANCH)
    return
  }
  const tracking = !created && args.some((arg) => arg === '-t' || arg.startsWith('--track'))
  if (tracking && target.includes('/')) {
    record(target.slice(target.indexOf('/') + 1))
    return
  }
  const isBranch = created || subcommand === 'switch'
    || git(dir, ['rev-parse', '--verify', '-q', `refs/heads/${target}`])
    || git(dir, ['for-each-ref', '--count=1', '--format=%(refname)', `refs/remotes/*/${target}`])
  if (isBranch) record(target)
}

// The protected checkout `target` lies in, or that lies within `target` when it is a folder (a
// delete of the folder holding a main checkout takes it too). A target that does not exist yet is
// judged by its nearest existing parent; a path inside `.git` by the checkout that owns it.
function protectedCheckout(target) {
  const parts = target.split(path.sep)
  const gitDir = parts.indexOf('.git')
  let dir = gitDir > 0 ? parts.slice(0, gitDir).join(path.sep) || path.sep : target
  while (!fs.existsSync(dir) && path.dirname(dir) !== dir) dir = path.dirname(dir)
  const isDir = fs.existsSync(dir) && fs.statSync(dir).isDirectory()
  const holding = checkoutAt(isDir ? dir : path.dirname(dir))
  if (holding || !isDir || dir !== target) return holding
  return containedCheckout(dir, CONTAINED_CHECKOUT_DEPTH)
}

function containedCheckout(dir, depth) {
  if (depth === 0) return null
  let entries = []
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries.filter((e) => e.isDirectory() && e.name !== '.git' && e.name !== 'node_modules').slice(0, 200)) {
    const child = path.join(dir, entry.name)
    const found = fs.existsSync(path.join(child, '.git')) ? checkoutAt(child) : containedCheckout(child, depth - 1)
    if (found) return found
  }
  return null
}

// Where a delete operand points. The shell rewrites `$VAR`, globs, and `~` before rm sees them, so
// the literal part before the first expansion decides: `$TMPDIR/x` is temp, `/repo/src/*` is
// /repo/src, and a word that starts with an expansion (`"$f"`, `*.log`) is judged by the folder the
// command runs in.
function operandPath(cwd, word) {
  const tmpdir = /^\$\{?TMPDIR\}?(\/|$)/.exec(word)
  if (tmpdir) word = `${process.env.TMPDIR || os.tmpdir()}/${word.slice(tmpdir[0].length)}`
  const home = /^~(\/|$)/.test(word) ? os.homedir() + word.slice(1) : word
  const absolute = (written) => (written.startsWith('/') ? written : `${cwd}/${written}`)
  const literal = home.split(/[$`*?[{]/)[0]
  if (literal === home) return physicalPath(absolute(home), true)
  if (!literal) return physicalPath(cwd)
  return physicalPath(absolute(literal.endsWith('/') ? literal : literal.slice(0, literal.lastIndexOf('/') + 1) || '.'))
}

// Asks when any target lies in, or holds, a checkout on a protected branch. A command Claude runs
// outside its sandbox (`dangerouslyDisableSandbox`) has no write limit, so there any delete outside
// the temp folders asks.
let unsandboxed = false

function classifyDelete(cwd, command, targets) {
  for (const word of targets.length ? targets : ['.']) {
    const target = operandPath(cwd, word)
    if (inTemp(target)) continue
    const checkout = protectedCheckout(target)
    if (checkout) return askDelete(command, checkout)
    if (unsandboxed) {
      return { decision: 'ask', reason: `roborepo: \`${command}\` deletes ${target} outside Claude's shell sandbox, which would otherwise limit it to the checkout and temp folders. Confirm this delete.` }
    }
  }
  return null
}

// The path operands of rm, rmdir, or unlink: every word after the options, or after `--`.
function deleteTargets(args) {
  const end = args.indexOf('--')
  const before = end === -1 ? args : args.slice(0, end)
  const after = end === -1 ? [] : args.slice(end + 1)
  return [...before.filter((arg) => !arg.startsWith('-') && !/^[0-9]?[<>]/.test(arg)), ...after]
}

// `find <paths> ... -delete` (or `-exec rm`): the starting paths, which precede the first expression.
// The operands written into `-exec rm …` count as well: they are deleted wherever find runs.
function findDeleteTargets(args) {
  const executed = []
  let deletes = args.includes('-delete')
  args.forEach((arg, k) => {
    if (!['-exec', '-execdir'].includes(arg) || !DELETE_PROGRAMS.has(path.basename(args[k + 1] ?? ''))) return
    deletes = true
    for (let m = k + 2; m < args.length && ![';', '+'].includes(args[m]); m += 1) {
      if (args[m] !== '{}' && !args[m].startsWith('-')) executed.push(args[m])
    }
  })
  if (!deletes) return null
  const first = args.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!')
  return [...(first === -1 ? args : args.slice(0, first)), ...executed]
}

// The program xargs runs: the first word after its options and their values.
function xargsProgram(args) {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]
    if (XARGS_VALUE_OPTIONS.has(arg)) k += 1
    else if (!arg.startsWith('-')) return { program: arg, args: args.slice(k + 1) }
  }
  return null
}

// The git subcommands that delete files or throw away uncommitted work in the checkout.
function gitDeletes(subcommand, args) {
  const operands = args.filter((arg) => !arg.startsWith('-'))
  if (subcommand === 'rm') return 'git rm'
  if (subcommand === 'clean' && args.some((arg) => arg === '--force' || /^-[a-z]*f/i.test(arg))) return 'git clean'
  if (subcommand === 'reset' && args.includes('--hard')) return 'git reset --hard'
  if (subcommand === 'stash' && ['drop', 'clear'].includes(operands[0])) return `git stash ${operands[0]}`
  if (subcommand === 'restore') {
    const staged = args.some((arg) => arg === '--staged' || arg === '-S')
    const worktree = args.some((arg) => arg === '--worktree' || arg === '-W')
    if (!staged || worktree) return 'git restore'
  }
  return null
}

// The git subcommands that bring other commits into the checked-out branch.
const INTEGRATING_SUBCOMMANDS = ['merge', 'pull', 'rebase', 'cherry-pick', 'am']
// merge and pull options that take the next word as their value.
const INTEGRATE_VALUE_OPTIONS = new Set([
  '-m', '-F', '-s', '-X', '--strategy', '--strategy-option', '--file', '--message',
  '--depth', '--deepen', '--shallow-since', '--shallow-exclude', '-j', '--jobs', '-o', '--server-option',
])

// Stopping one in progress (`--abort`, `--quit`) brings nothing in. A fast-forward-only pull or
// merge from the branch's own upstream adds no new commits, so it stays allowed: the remote must be
// the branch's configured remote (origin when none is set), and the branch its own. A fast-forward
// to anything else would land that other history, so it does not.
// `git -c …` (`configured`) or `--upload-pack` can point the fetch at another repository, so either
// one rules the fast-forward exception out.
function gitIntegrates(dir, subcommand, args, branch, configured = false) {
  if (!INTEGRATING_SUBCOMMANDS.includes(subcommand)) return null
  if (args.some((arg) => arg === '--abort' || arg === '--quit')) return null
  const operands = []
  for (let k = 0; k < args.length; k += 1) {
    if (INTEGRATE_VALUE_OPTIONS.has(args[k])) k += 1
    else if (!args[k].startsWith('-')) operands.push(args[k])
  }
  // git honors the last of --ff-only, --ff, and --no-ff.
  const redirected = configured || args.some((arg) => arg.startsWith('--upload-pack'))
  if (!redirected && args.lastIndexOf('--ff-only') > Math.max(args.lastIndexOf('--ff'), args.lastIndexOf('--no-ff'))) {
    const remote = git(dir, ['config', `branch.${branch}.remote`]) || 'origin'
    const ownBranch = (ref) => ref === branch || ref === `refs/heads/${branch}`
    if (subcommand === 'pull' && (operands.length === 0 || (operands[0] === remote && (operands.length === 1 || (operands.length === 2 && ownBranch(operands[1])))))) return null
    if (subcommand === 'merge' && operands.length === 1 && [`@{u}`, `@{upstream}`, `${branch}@{u}`, `${branch}@{upstream}`, `${remote}/${branch}`, `refs/remotes/${remote}/${branch}`].includes(operands[0])) return null
  }
  return `git ${subcommand}`
}

function denyIntegrate(command, { top, branch }) {
  return {
    decision: 'deny',
    reason: `roborepo: \`${command}\` would bring other commits into protected branch "${branch}", checked out at ${top}. Agents never merge into ${branch}: merge it into a feature branch instead (\`roborepo plans sync-base\` from that branch's worktree), and update ${branch} itself only with \`git pull --ff-only\`.`,
  }
}

function askDelete(command, { top, branch }) {
  const where = `${top}, which has protected branch "${branch}" checked out`
  if (forCodex) {
    return {
      decision: 'deny',
      reason: `roborepo: \`${command}\` deletes in ${where}. Codex cannot ask you to confirm it, so agents may not run it there. Work in a feature-branch worktree, or run it yourself.`,
    }
  }
  return { decision: 'ask', reason: `roborepo: \`${command}\` deletes in ${where}. Confirm this delete.` }
}

// Marks where a subshell or command substitution opens and closes, as words of their own, so the
// walk can give it its own working folder: a `cd` inside `( … )` ends with it.
const SCOPE_OPEN = '\u0001('
const SCOPE_CLOSE = '\u0001)'
// Stands in for a substitution's output; the `$` keeps every reader from following it.
const SUBSTITUTION_PLACEHOLDER = '$__SUBSTITUTION'
// The same, split off the bare name it was written against (`pu$(…)sh`), so a reader can tell the
// name is incomplete.
const JOINED_SUBSTITUTION_PLACEHOLDER = '$__JOINED_SUBSTITUTION'

// Splits subshells and command substitutions into their own commands, each between scope markers.
// An unquoted `( … )` is marked where it stands. A `$(…)` or backtick substitution leaves an
// unexpanded placeholder word in the command around it, which keeps the rest of that command whole
// (`git -C $(pwd) clean -f`, `cd $(…)`), and its own commands are walked right after that command
// ends; a substitution's `cd` cannot change the folder its outer command runs in. Single-quoted
// text is never run, so it is kept.
function exposeNestedCommands(text) {
  let i = 0
  // Reads until `end` (`)` or a backtick; null for the whole text) and returns the rewritten text.
  const parse = (end) => {
    let out = ''
    let quote = null
    let depth = 0
    let pending = []
    const flush = () => {
      // The newline ends a comment inside the substitution (`` `#x` ``) where the substitution ends.
      for (const inner of pending) out += ` ; ${SCOPE_OPEN} ; ${inner}\n ; ${SCOPE_CLOSE} ; `
      pending = []
    }
    while (i < text.length) {
      const ch = text[i]
      if (quote === "'") {
        if (ch === "'") quote = null
        out += ch
        i += 1
      } else if (quote === "$'") {
        // A `$'…'` string runs nothing either; its `\'` does not close it.
        if (ch === "'") quote = null
        const escaped = ch === '\\' && i + 1 < text.length
        out += escaped ? ch + text[i + 1] : ch
        i += escaped ? 2 : 1
      } else if (ch === '\\' && text[i + 1] === '\n') {
        i += 2 // a backslash-newline joins the lines
      } else if (ch === '$' && text[i + 1] === "'" && quote === null) {
        quote = "$'"
        out += "$'"
        i += 2
      } else if (ch === '\\' && i + 1 < text.length) {
        out += ch + text[i + 1]
        i += 2
      } else if (ch === '`' && end === '`') {
        i += 1
        flush()
        return out
      } else if ((ch === '$' && text[i + 1] === '(') || ch === '`') {
        i += ch === '$' ? 2 : 1
        pending.push(parse(ch === '$' ? ')' : '`'))
        // The placeholder joins the word it is part of (`$TMPDIR/$(date)`), except after a bare
        // name or option, so `rm$(…)` and `-delete$(…)` still read as `rm` and `-delete`.
        const word = /[^\s;&|]*$/.exec(out)[0]
        out += quote === null && /^-*[A-Za-z]+$/.test(word) ? ` ${JOINED_SUBSTITUTION_PLACEHOLDER}` : SUBSTITUTION_PLACEHOLDER
      } else if (ch === '"' || (ch === "'" && quote === null)) {
        quote = quote === ch ? null : quote ?? ch
        out += ch
        i += 1
      } else if (quote === '"') {
        out += ch
        i += 1
      } else if (ch === '(') {
        depth += 1
        flush()
        out += ` ; ${SCOPE_OPEN} ; `
        i += 1
      } else if (ch === ')') {
        i += 1
        flush()
        if (depth === 0 && end === ')') return out
        if (depth > 0) depth -= 1
        out += ` ; ${SCOPE_CLOSE} ; `
      } else if (';|\n'.includes(ch) || (ch === '&' && !/[<>]$/.test(out))) {
        out += ch
        i += 1
        flush()
      } else {
        out += ch
        i += 1
      }
    }
    flush()
    return out
  }
  return parse(null)
}

// Drops redirections (`>/dev/null`, `2>&1`, `> out`) from a word list.
function withoutRedirects(args) {
  const out = []
  for (let i = 0; i < args.length; i += 1) {
    const redirect = /^(\d*|&)(>>?|<)(.*)$/.exec(args[i])
    if (!redirect) out.push(args[i])
    else if (redirect[3] === '') i += 1
  }
  return out
}

// The directory a `cd` or `pushd` word list moves to, or null when it cannot be followed. `$TMPDIR`
// and `~` are expanded; other expansions are not.
function changedDirectory(cwd, args) {
  const dir = args.filter((arg) => arg !== '--')
  if (dir.length === 0) return os.homedir()
  if (dir.length !== 1 || dir[0].startsWith('-') || /[`<>]/.test(dir[0])) return null
  const tmpdir = /^\$\{?TMPDIR\}?(\/|$)/.exec(dir[0])
  if (tmpdir) return path.resolve(process.env.TMPDIR || os.tmpdir(), dir[0].slice(tmpdir[0].length))
  if (dir[0].includes('$')) return null
  const target = /^~(\/|$)/.test(dir[0]) ? os.homedir() + dir[0].slice(1) : dir[0]
  return path.resolve(cwd, target)
}

// Where a simple command's program word sits, past variable assignments, shell keywords, and
// wrappers with their options (`if … then rm`, `env rm`, `sudo -u x rm`).
function programIndex(words) {
  let i = 0
  for (;;) {
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i])) i += 1
    if (!SHELL_KEYWORDS.has(words[i])) return i
    const valueOptions = WRAPPER_VALUE_OPTIONS[words[i]]
    i += 1
    while (i < words.length && words[i].startsWith('-')) i += valueOptions?.has(words[i]) ? 2 : 1
  }
}

// Walks every simple command looking for deletes, following `cd`, `cd -`, `pushd`, and `popd`,
// shell keywords and wrappers (`if … then rm`, `env rm`, `sudo rm`), subshells and command
// substitutions (each with its own working folder), and `sh -c`.
function classifyDeletes(text, startCwd) {
  let cwd = startCwd
  // Other folders the shell may be in. A cd or pushd to a folder that does not exist yet may succeed
  // (an earlier mkdir made it) or fail (the shell stays put), so both outcomes are kept, through any
  // number of such moves; later commands are judged in every one.
  let others = []
  let previous = startCwd
  const outcomes = (from, args) => {
    const next = changedDirectory(from, args)
    if (next === null) return [from]
    return fs.existsSync(next) ? [next] : [next, from]
  }
  // Past 16 folders, each missing one is replaced by its nearest existing parent, where a delete
  // inside it would be judged anyway, and the starting folder is always kept.
  const nearestExisting = (folder) => {
    while (!fs.existsSync(folder) && path.dirname(folder) !== folder) folder = path.dirname(folder)
    return folder
  }
  // Collapsing loses where a later relative `cd ..` would lead, so once the cap is passed the walk
  // also judges every later command in the starting folder.
  let capped = false
  const keepOthers = (folders) => {
    let kept = [...new Set(folders)]
    if (kept.length > 17) {
      capped = true
      kept = kept.map(nearestExisting)
    }
    if (capped) kept.push(startCwd)
    others = [...new Set(kept)].filter((folder) => folder !== cwd)
  }
  const dirStack = []
  const scopes = []
  let result = null
  // A move the walk cannot follow still makes the current folder the shell's previous one, so a
  // later `cd -` returns there; the walk itself stays put.
  // `previousOthers` are the other folders the shell may have been in before its last move.
  let previousOthers = []
  const moveTo = (next) => {
    previous = cwd
    previousOthers = others
    if (next !== null) cwd = next
  }
  for (const words of splitCommands(exposeNestedCommands(withoutComments(text)))) {
    if (words[0] === SCOPE_OPEN) {
      scopes.push({ cwd, others, previous, previousOthers, stack: dirStack.slice() })
      continue
    }
    if (words[0] === SCOPE_CLOSE) {
      const scope = scopes.pop()
      if (scope) {
        ;({ cwd, others, previous, previousOthers } = scope)
        dirStack.splice(0, dirStack.length, ...scope.stack)
      }
      continue
    }
    const i = programIndex(words)
    const program = words[i] && path.basename(words[i])
    const args = words.slice(i + 1)
    const dirArgs = ['cd', 'pushd'].includes(program) ? withoutRedirects(args) : args
    // Only redirect-looking words: `cd ">x"` loses its quotes before this, so its target is unknown.
    const onlyRedirects = args.length > 0 && dirArgs.length === 0
    // `cd -`, `popd`, and bare `pushd` return to a folder recorded earlier, together with the other
    // folders that were possible then.
    const before = [cwd, ...others]
    if (program === 'cd' && dirArgs.length === 1 && dirArgs[0] === '-') {
      const back = [previous, ...previousOthers]
      moveTo(previous)
      keepOthers(back)
    } else if (program === 'cd' || (program === 'pushd' && dirArgs.length > 0)) {
      const all = onlyRedirects ? before : before.flatMap((folder) => outcomes(folder, dirArgs))
      // A move that may fail leaves the shell's previous folder, and its directory stack, as they
      // were, so a later `cd -` or `popd` may land on those too.
      const mayFail = all.some((folder) => before.includes(folder))
      const earlierPrevious = [previous, ...previousOthers]
      // Each stack entry holds every folder the shell may have been in; `maybe` marks a pushd that
      // may have failed and pushed nothing.
      if (program === 'pushd') dirStack.push(Object.assign([...before], { maybe: mayFail }))
      moveTo(onlyRedirects ? null : changedDirectory(cwd, dirArgs))
      keepOthers(all)
      if (mayFail) previousOthers = [...new Set([...previousOthers, ...earlierPrevious])].filter((folder) => folder !== previous)
    } else if (program === 'pushd') {
      // Bare `pushd` swaps the current folder with the top of the stack.
      if (dirStack.length) {
        const top = dirStack.pop()
        const beneath = top.maybe && dirStack.length ? dirStack.at(-1) : []
        dirStack.push(before)
        moveTo(top[0])
        keepOthers([...top, ...beneath])
      }
    } else if (program === 'popd') {
      if (dirStack.length) {
        const top = dirStack.pop()
        // If the pushd that made `top` may have failed, popd may pop the entry beneath it instead.
        const beneath = top.maybe && dirStack.length ? dirStack.at(-1) : []
        moveTo(top[0])
        keepOthers([...top, ...beneath])
      }
    } else {
      for (const base of [cwd, ...others]) result = stricter(result, judgeCommand(base, program, args))
    }
  }
  return result
}

// The delete or merge decision for one simple command run in `cwd`.
function judgeCommand(cwd, program, args) {
  let result = null
  if (SHELLS.has(program)) {
    const flag = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w))
    if (flag !== -1 && args[flag + 1]) result = stricter(result, classifyDeletes(args[flag + 1], cwd))
  } else if (DELETE_PROGRAMS.has(program)) {
    result = stricter(result, classifyDelete(cwd, program, deleteTargets(args)))
  } else if (program === 'find') {
    const targets = findDeleteTargets(args)
    if (targets) result = stricter(result, classifyDelete(cwd, 'find -delete', targets))
  } else if (program === 'xargs') {
    // Most paths arrive on stdin, so the directory xargs runs in stands in for them; any written
    // after the program are checked too.
    const deleter = xargsProgram(args)
    if (deleter && DELETE_PROGRAMS.has(path.basename(deleter.program))) {
      result = stricter(result, classifyDelete(cwd, `xargs ${deleter.program}`, ['.', ...deleteTargets(deleter.args)]))
    }
  } else if (program === 'git') {
    let gitCwd = cwd
    let configured = false
    let j = 0
    while (j < args.length && args[j].startsWith('-')) {
      if (args[j] === '-C') {
        gitCwd = path.resolve(gitCwd, args[j + 1] ?? '')
        j += 2
      } else {
        if (args[j] === '-c' || args[j].startsWith('--config-env')) configured = true
        j += ['-c', '--git-dir', '--work-tree', '--namespace', '--config-env'].includes(args[j]) ? 2 : 1
      }
    }
    if (['switch', 'checkout'].includes(args[j])) recordBranchChange(gitCwd, args[j], args.slice(j + 1))
    const deletes = args[j] && gitDeletes(args[j], args.slice(j + 1))
    if (deletes) result = stricter(result, classifyDelete(gitCwd, deletes, []))
    const checkout = args[j] && INTEGRATING_SUBCOMMANDS.includes(args[j]) && checkoutAt(gitCwd)
    const integrates = checkout && gitIntegrates(gitCwd, args[j], args.slice(j + 1), checkout.branch, configured)
    if (integrates) result = stricter(result, denyIntegrate(integrates, checkout))
  }
  return result
}

function unknownDefault(remote) {
  return ask(`the default branch of \`${remote}\` is not recorded here, so this push may land on it. \`git remote set-head ${remote} --auto\` records it`)
}

function deny(branch, detail) {
  const instead = branch === PLANS_STORE_BRANCH
    ? 'It holds the plans store: change plans with `roborepo plans` commands, which push for you.'
    : 'Push a feature branch and open a pull request instead.'
  return {
    decision: 'deny',
    reason: `roborepo: pushing to protected branch "${branch}" is blocked for agents (${detail}). ${instead}`,
  }
}

function denyForce(what) {
  return {
    decision: 'deny',
    reason: `roborepo: force pushes are blocked for agents (${what} rewrites published history). Push without force, or run it yourself.`,
  }
}

function ask(detail) {
  if (forCodex) {
    return {
      decision: 'deny',
      reason: `roborepo: ${detail}. Codex cannot ask you to confirm it, so agents may not run it. Run the push yourself after checking it does not reach main.`,
    }
  }
  return { decision: 'ask', reason: `roborepo: ${detail}. Confirm this push does not reach main.` }
}

// How many `git push` commands classifyCommand read, at any depth. A push it never reached (behind a
// wrapper, in a subshell or substitution, through an alias) is caught by `unreadPushes`.
let pushesRead = 0

// Walks every simple command, following `cd` so a later `git push` is resolved in the right
// directory, and descending into `sh -c '...'` strings. A deny or ask from any push wins. A push with
// a leading environment assignment or `git -c` asks: either can point git at another destination or
// away from the backstop, and Claude has no push ask rule to fall back on. The result is VERIFIED only
// when every simple command is a `cd` or a verified push run plainly.
function classifyCommand(text, startCwd) {
  let cwd = startCwd
  let result = null
  let onlyVerifiedPushes = true
  for (const words of splitCommands(withoutComments(text), { parens: true })) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(words[i])) i += 1
    const plain = i === 0
    const program = words[i] && path.basename(words[i])
    if (program === 'cd' && plain && words[i + 1] && !/[$`~<>]/.test(words[i + 1]) && words.length === 2) {
      cwd = path.resolve(cwd, words[i + 1])
      continue
    }
    onlyVerifiedPushes &&= program === 'git'
    // A redirect into a file writes it, which the push approval does not cover; discarding output
    // (`2>/dev/null`, `2>&1`) does not.
    const writesFile = words.some((word, k) => {
      const redirect = /^(\d*|&)(>>?)(.*)$/.exec(word)
      if (!redirect) return false
      const target = redirect[3] || words[k + 1] || ''
      return target !== '/dev/null' && !/^&\d$/.test(target)
    })
    if (writesFile) onlyVerifiedPushes = false
    if (SHELLS.has(program)) {
      const flag = words.findIndex((w, j) => j > i && /^-[a-z]*c[a-z]*$/.test(w))
      if (flag !== -1 && words[flag + 1]) result = stricter(result, withoutAllow(classifyCommand(words[flag + 1], cwd)))
      continue
    }
    if (program !== 'git') continue

    let gitCwd = cwd
    let configured = false
    let j = i + 1
    while (j < words.length && words[j].startsWith('-')) {
      if (words[j] === '-C') {
        gitCwd = path.resolve(gitCwd, words[j + 1] ?? '')
        j += 2
      } else if (words[j] === '-c') {
        configured = true
        j += 2
      } else j += 1
    }
    if (words[j] !== 'push') {
      onlyVerifiedPushes = false
      continue
    }
    pushesRead += 1
    const pushResult = classifyPush(gitCwd, words.slice(j + 1))
    if (pushResult !== VERIFIED || !plain || configured) onlyVerifiedPushes = false
    result = stricter(result, withoutAllow(pushResult))
    if ((!plain || configured) && pushResult === VERIFIED) {
      result = stricter(result, ask('`git -c` or an environment prefix can change where this push lands or skip the pre-push check'))
    }
  }
  if (result) return result
  return onlyVerifiedPushes && backstopInstalled() ? VERIFIED : null
}

// Wrappers that run a program named after their own options and operands (`timeout 5 codex`,
// `xargs codex`, `npx codex`, `npx @openai/codex`): each with the options that take a value and how
// many operands come before the program.
const LAUNCH_WRAPPERS = {
  timeout: { values: new Set(['-s', '--signal', '-k', '--kill-after']), operands: 1 },
  xargs: { values: XARGS_VALUE_OPTIONS, operands: 0 },
  npx: { values: new Set(['-p', '--package', '-w', '--workspace']), operands: 0 },
}

// Where the program a simple command finally runs sits: past what `programIndex` skips and past
// the launch wrappers above, in any order. A wrapper named by its path (`/usr/bin/env gh`) is
// skipped like the bare name; this only ever finds more programs to refuse.
function launchedProgram(words) {
  const named = words.map((word) => (/^[^=]*\/[^/=]+$/.test(word) && SHELL_KEYWORDS.has(path.basename(word)) ? path.basename(word) : word))
  let i = programIndex(named)
  for (;;) {
    const wrapper = LAUNCH_WRAPPERS[path.basename(words[i] ?? '')]
    if (!wrapper) return i
    i += 1
    while (i < words.length && words[i].startsWith('-') && words[i] !== '--') i += wrapper.values.has(words[i]) ? 2 : 1
    if (words[i] === '--') i += 1
    i += wrapper.operands
    i += programIndex(named.slice(i))
  }
}

// A program word as a name: its basename without an npx version (`@openai/codex@latest` is codex).
function programName(word) {
  return path.basename(word ?? '').replace(/(?<=.)@[^@/]*$/, '')
}

// Text the launched program at `at` runs as a script: the string a shell gets with `-c` or `<<<`,
// what `eval` or `watch` runs, and an `env -S` string before it. An argument that only spells one
// of these (`printf '%s' sh -c '…'`) runs nothing.
function launchScripts(words, at) {
  const name = programName(words[at])
  const scripts = []
  if (SHELLS.has(name)) {
    const flag = words.findIndex((w, m) => m > at && /^-[a-z]*c[a-z]*$/.test(w))
    if (flag !== -1 && words[flag + 1]) scripts.push(words[flag + 1])
  }
  if (SHELLS.has(name) || name === 'source' || name === '.') {
    words.forEach((word, k) => {
      if (k > at && word.includes('<<<')) scripts.push(word.slice(word.indexOf('<<<') + 3) || words[k + 1] || '')
    })
  }
  if (name === 'eval' || name === 'watch') scripts.push(words.slice(at + 1).join(' '))
  words.slice(0, at).forEach((word, k) => {
    const rest = words.slice(k + 1, at + 1)
    if (path.basename(word) === 'env' && rest.some((w) => /^(-S|--split-string)/.test(w))) {
      scripts.push(words.slice(k + 1).map((w) => w.replace(/^(-S|--split-string=?)/, '')).join(' '))
    }
  })
  return scripts
}

const CODEX_OVERRIDE_DENIAL = { decision: 'deny', reason: 'roborepo: a Codex `-c`/`--config` override of the shell environment or a GitHub identity variable never reaches a hook, so a Codex session started this way could run `gh api` as another account. Run it yourself.' }

// The deny for a `gh` command that skips git, or a Codex launch whose `-c` override could change
// which account its shells' gh acts as, wherever it runs: behind a wrapper (`env`, `command`,
// `timeout`, `xargs`, `npx`), inside `( … )`, `$(…)`, or backticks, or in a script handed to a shell
// (`sh -c`, `eval`, `env -S`).
function classifyLaunches(text) {
  let result = null
  for (const words of splitCommands(exposeNestedCommands(withoutComments(text)))) {
    if (words[0] === SCOPE_OPEN || words[0] === SCOPE_CLOSE) continue
    const at = launchedProgram(words)
    const program = programName(words[at])
    if (hostCliFor(program)) result = stricter(result, classifyHostCli(hostCliFor(program), words.slice(at + 1), words.expands.slice(at + 1)))
    else if (program === 'codex' && codexIdentityOverride(words.slice(at + 1)) && anyAgentIdentityActive()) result = stricter(result, CODEX_OVERRIDE_DENIAL)
    for (const script of launchScripts(words, at)) result = stricter(result, classifyLaunches(script))
  }
  return result
}

// Programs that run text they are given, or a file written earlier in the command.
const SCRIPT_RUNNERS = new Set(['source', '.', 'eval', 'exec', 'xargs', 'timeout', 'watch', 'parallel', 'script'])
// Interpreters that can run text they read (`python3 -c 'os.system(…)'`, a Makefile written
// earlier). Any `python` version counts too.
const INTERPRETERS = new Set(['awk', 'gawk', 'perl', 'ruby', 'node', 'dash', 'ksh', 'fish', 'pwsh', 'busybox', 'make', 'gmake'])

// `text` with operator characters inside quotes replaced by `_`, so `git commit -m "fix push; make
// it clearer"` stays one command. A `$(…)` or backtick inside double quotes still runs, so it is kept.
function maskQuotedOperators(text) {
  let out = ''
  const open = [] // ' $' " $( ( `
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    const top = open.at(-1)
    if (top === "'" || top === "$'") {
      if (top === "$'" && ch === '\\' && i + 1 < text.length) {
        out += '__'
        i += 1
        continue
      }
      if (ch === "'") open.pop()
      out += /[;&|()<>`\n{}$]/.test(ch) ? '_' : ch
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1]
      i += 1
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      open.push('$(')
      out += '$('
      i += 1
      continue
    }
    if (top === '"') {
      if (ch === '"') open.pop()
      else if (ch === '`') open.push('`')
      out += /[;&|()<>\n{}]/.test(ch) ? '_' : ch
      continue
    }
    if (ch === '$' && text[i + 1] === "'") {
      open.push("$'")
      out += "$'"
      i += 1
      continue
    }
    if (ch === "'" || ch === '"') open.push(ch)
    else if (ch === '`') top === '`' ? open.pop() : open.push('`')
    else if (ch === '(') open.push('(')
    else if (ch === ')' && (top === '$(' || top === '(')) open.pop()
    out += ch
  }
  return out
}

// The simple commands of `text`, each as its words with quotes and backslashes removed. It splits
// at operators and at subshell and substitution edges, cuts a redirect glued to the program
// (`bash>log`, `sh<&0`), and drops redirects in front of it, so `(sh)` and `bash<x` still name `sh`
// and `bash`.
function simpleCommands(text) {
  // `>|` is a redirect, not a pipe.
  return maskQuotedOperators(withoutComments(text)).replace(/>\|/g, '>').split(/[;&|()`\n]|\$\(/).map((part) => {
    const words = []
    const raw = part.trim().split(/\s+/).filter(Boolean)
    for (let i = 0; i < raw.length; i += 1) {
      const word = raw[i].replace(/['"\\]/g, '')
      if (!words.length && /^(\d*|\{\w+\})[<>]/.test(word)) {
        // A bare operator: its target is the next word.
        if (/^(\d*|\{\w+\})[<>]+&?$/.test(word)) i += 1
        continue
      }
      words.push(words.length ? word : word.replace(/\d*[<>].*$/, ''))
    }
    return words
  })
}

// A command whose program the shell fills in from a substitution (`$(which sh) x`, quoted or not),
// behind any assignments, wrappers, or keywords. `((`, `$((`, and `=(` open arithmetic or an array,
// not a command. Words and gaps stop at an operator or newline, so each command start scans only its
// own command and the time stays linear. It reads text from `maskQuotedOperators`.
const SUBSTITUTED_PROGRAM = /(?:^|[;&|\n]|(?<![(=$])\((?!\()|\$\((?!\())[ \t]*(?:[A-Za-z_]\w*\+?=[^\s;&|()]*[ \t]+)*(?:(?:env|sudo|nohup|nice|time|exec|command|builtin|then|do|else|if|while|until|!)[ \t]+(?:-[^\s;&|()]+[ \t]+)*)*"?(?:\$\(|`)/

// Whether some line of `text` starts a program that could run a heredoc's body or a file it wrote:
// a shell, a script runner or interpreter, a program the shell fills in (`$SHELL`, `$(which sh)`),
// a path (`./x.sh`), `env -S`, or a process substitution. It reads the command with heredoc bodies
// taken out, so a body's prose does not count, and it errs toward keeping a body.
function mayRunScripts(text) {
  const masked = maskQuotedOperators(withoutComments(text))
  if (/[<>]\(/.test(masked) || SUBSTITUTED_PROGRAM.test(masked)) return true
  return simpleCommands(text).some((words) => {
    const p = programIndex(words)
    const program = words[p]
    const before = words.slice(0, p)
    const splitString = before.some((word) => /^(-[A-Za-z]*S|--split-string)/.test(word))
    if (before.includes('env') && splitString) return true
    const name = path.basename(program ?? '')
    return Boolean(program) && (SHELLS.has(name) || SCRIPT_RUNNERS.has(program) || INTERPRETERS.has(name)
      || /^python[\d.]*$/.test(name) || program.startsWith('$') || program.includes('/'))
  })
}

// Whether the simple command `words` only stores or forwards a heredoc as data: `cat` (into a file
// or a substitution), `tee`, a git message read from stdin, or a body for a provider's CLI (gh).
function readsHeredocAsData(words) {
  const p = programIndex(words)
  const program = path.basename(words[p] ?? '')
  if (['cat', 'tee'].includes(program) || hostCliFor(program)) return true
  if (program !== 'git') return false
  let j = p + 1
  while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1
  return ['commit', 'tag', 'notes'].includes(words[j])
}

// Drops the body of a `<<` heredoc only when it is plainly data, so the prose of a commit message
// or a written file is not taken for commands: the heredoc's own command reads it as data
// (`readsHeredocAsData`), nothing pipes that command onward, no line of the whole command could run
// it (`mayRunScripts`), and the shell expands nothing in it (a quoted delimiter, or no `$(` or
// backtick in the body). Every other body is kept. Quotes, `$(…)`, backticks, and comments are
// tracked so a `<<` inside a string is not taken for a heredoc, and a body whose closing line never
// appears is kept. With `skeleton`, every body is dropped except one the shell expands, leaving the
// commands around them for `mayRunScripts`.
function withoutHeredocBodies(text, skeleton = false) {
  let out = ''
  const open = [] // quotes and substitutions still open: ' $' " $( ( `
  let pending = []
  let i = 0
  const runsScripts = !skeleton && mayRunScripts(withoutHeredocBodies(text, true))
  while (i < text.length) {
    const ch = text[i]
    const top = open.at(-1)
    if (top === "'" || top === "$'") {
      if (ch === '\\' && top === "$'" && i + 1 < text.length) {
        out += ch + text[i + 1]
        i += 2
        continue
      }
      if (ch === "'") open.pop()
      out += ch
      i += 1
      continue
    }
    if (ch === '\\' && i + 1 < text.length) {
      out += ch + text[i + 1]
      i += 2
      continue
    }
    if (ch === '$' && text[i + 1] === '(') {
      open.push('$(')
      out += '$('
      i += 2
      continue
    }
    if (top === '"') {
      if (ch === '"') open.pop()
      else if (ch === '`') open.push('`')
      out += ch
      i += 1
      continue
    }
    if (ch === '$' && text[i + 1] === "'") {
      open.push("$'")
      out += "$'"
      i += 2
      continue
    }
    if (ch === "'" || ch === '"') open.push(ch)
    else if (ch === '`') top === '`' ? open.pop() : open.push('`')
    else if (ch === '(') open.push('(')
    else if (ch === ')' && (top === '$(' || top === '(')) open.pop()
    else if (ch === '#' && (i === 0 || /[\s;&|(]/.test(text[i - 1]))) {
      const end = text.indexOf('\n', i)
      out += text.slice(i, end === -1 ? text.length : end)
      i = end === -1 ? text.length : end
      continue
    } else if (text.startsWith('<<<', i)) {
      out += '<<<'
      i += 3
      continue
    } else if (text.startsWith('<<', i)) {
      let k = i + 2
      const stripTabs = text[k] === '-'
      if (stripTabs) k += 1
      while (text[k] === ' ' || text[k] === '\t') k += 1
      let delimiter = ''
      let quote = null
      // A quoted delimiter (`'EOF'`, `"EOF"`, `\EOF`) keeps the shell from expanding the body.
      let literal = false
      for (; k < text.length; k += 1) {
        const c = text[k]
        if (quote) {
          if (c === quote) quote = null
          else delimiter += c
        } else if (c === "'" || c === '"') {
          quote = c
          literal = true
        } else if (c === '\\' && k + 1 < text.length) {
          delimiter += text[++k]
          literal = true
        } else if (/[\s;&|<>()]/.test(c)) break
        else delimiter += c
      }
      if (delimiter && !quote) {
        const ownCommand = simpleCommands(out).at(-1)
        const lineEnd = text.indexOf('\n', k)
        const pipedOn = text.slice(k, lineEnd === -1 ? text.length : lineEnd).includes('|')
        pending.push({ delimiter, stripTabs, literal, kept: !skeleton && (runsScripts || pipedOn || !readsHeredocAsData(ownCommand)) })
      }
      out += text.slice(i, k)
      i = k
      continue
    } else if (ch === '\n' && pending.length) {
      out += ch
      i += 1
      for (const heredoc of pending) {
        let closing = -1
        for (let start = i; start <= text.length;) {
          const end = text.indexOf('\n', start) === -1 ? text.length : text.indexOf('\n', start)
          const line = text.slice(start, end)
          if ((heredoc.stripTabs ? line.replace(/^\t+/, '') : line) === heredoc.delimiter) {
            closing = end
            break
          }
          if (end === text.length) break
          start = end + 1
        }
        if (closing === -1) break // no closing line: keep the rest as it is
        const body = text.slice(i, closing)
        // The shell runs `$(…)` and backticks in a body whose delimiter is unquoted.
        if (heredoc.kept || (!heredoc.literal && /\$\(|`/.test(body))) out += body
        i = closing
      }
      pending = []
      continue
    }
    out += ch
    i += 1
  }
  return out
}

// git options that take the next word as their value.
const GIT_VALUE_OPTIONS = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
// Commands that change what a push reads before it runs: setting a variable git reads, or git's
// own remote, upstream, and push configuration.
const ENVIRONMENT_BUILTINS = new Set(['export', 'unset', 'declare', 'typeset', 'source', '.'])
// `git config` options that take the next word as their value.
const CONFIG_VALUE_OPTIONS = new Set(['-f', '--file', '--blob', '--type', '--default', '--comment', '--value'])
const PUSH_ENVIRONMENT = /^(GIT_[A-Za-z0-9_]*|HOME|XDG_CONFIG_HOME|PATH)\+?=/

function changesGitConfig(subcommand, args) {
  if (subcommand === 'config') {
    // A lookup (`git config --get x`, `git config x`, `git config get x`) changes nothing; a value,
    // an edit, or a removal does.
    const operands = []
    for (let k = 0; k < args.length; k += 1) {
      if (CONFIG_VALUE_OPTIONS.has(args[k])) k += 1
      else if (!args[k].startsWith('-')) operands.push(args[k])
    }
    if (['get', 'list'].includes(operands[0]) || args.some((arg) => /^(--get(-all|-regexp|-urlmatch)?|--list|-l)$/.test(arg))) return false
    return operands.length >= 2 || ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(operands[0])
      || args.some((arg) => /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)$/.test(arg))
  }
  if (subcommand === 'remote') return ['add', 'set-url', 'set-head', 'rename', 'remove', 'rm', 'set-branches'].includes(args.find((arg) => !arg.startsWith('-')))
  if (subcommand === 'branch') return args.some((arg) => arg.startsWith('--set-upstream-to') || /^-[A-Za-z]*u/.test(arg))
  return false
}

// Programs that never run their arguments, and git subcommands that run nothing a command line
// names. `sed` and `awk` can run commands, so they are not listed.
const INERT_PROGRAMS = new Set(['echo', 'printf', 'cat', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'head', 'tail', 'wc', 'less', 'more', 'sort', 'uniq', 'cut', 'tr', 'jq', 'true', 'false', ':'])
const INERT_GIT_SUBCOMMANDS = new Set([
  'log', 'show', 'diff', 'grep', 'status', 'blame', 'shortlog', 'describe', 'rev-parse', 'rev-list',
  'ls-files', 'ls-tree', 'cat-file', 'reflog', 'branch', 'tag', 'commit', 'add', 'mv', 'rm', 'restore', 'notes',
])

// Whether one simple command may run `git push` in a form the walk cannot read: a git word followed
// by a `push` word, a `git -c alias.*` that could define one, a brace word that expands to push
// (`git {push,}`), a subcommand the shell fills in (`git $CMD`, `git $(…)`), `xargs git` with its
// subcommand on stdin, or a program the shell fills in followed by a push word (`$GIT push`).
//
// With `mentionsOnly` (nothing in the command could run text as a script), a command that cannot
// push only mentions one, and does not count: an inert program (`echo git push`, `grep "git push"`)
// or a git subcommand that runs nothing (`git log --grep push`, `git commit -m "… push"`).
function mayPush(words, mentionsOnly = false) {
  const p = programIndex(words)
  if (mentionsOnly && INERT_PROGRAMS.has(path.basename(words[p] ?? ''))) return false
  const g = words.findIndex((word) => path.basename(word) === 'git')
  if (g !== -1) {
    const after = words.slice(g + 1)
    if (words.some((word) => word.startsWith('alias.'))) return true
    let j = g + 1
    while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1
    if (mentionsOnly && g === p && INERT_GIT_SUBCOMMANDS.has(words[j])) return false
    if (after.includes('push')) return true
    if (after.some((word) => !word.startsWith('-') && word.includes('{') && word.replace(/[{},]/g, '').includes('push'))) return true
    if (/[$`]/.test(words[j] ?? '') || words[j + 1]?.startsWith(JOINED_SUBSTITUTION_PLACEHOLDER)) return true
    if (words.slice(0, g).some((word) => path.basename(word) === 'xargs') && !/^[a-z][a-z0-9-]*$/.test(words[j] ?? '')) return true
  }
  return /[$`]/.test(words[p] ?? '') && words.slice(p + 1).includes('push')
}

// Text a command hands to a shell to run: `sh -c` strings, `eval` and `watch` arguments, `env -S`
// strings, and a `<<<` here-string given to a shell or to `source`.
function nestedScripts(words) {
  const scripts = []
  const shellCommand = words.some((word) => {
    const name = path.basename(word.split('<<<')[0])
    return SHELLS.has(name) || name === 'source' || name === '.'
  })
  words.forEach((word, k) => {
    const name = path.basename(word)
    if (SHELLS.has(name)) {
      const flag = words.findIndex((w, m) => m > k && /^-[a-z]*c[a-z]*$/.test(w))
      if (flag !== -1 && words[flag + 1]) scripts.push(words[flag + 1])
    }
    if (name === 'eval' || name === 'watch') scripts.push(words.slice(k + 1).join(' '))
    if (name === 'env' && words.slice(k + 1).some((w) => /^(-S|--split-string)/.test(w))) {
      scripts.push(words.slice(k + 1).map((w) => w.replace(/^(-S|--split-string=?)/, '')).join(' '))
    }
    if (shellCommand && word.includes('<<<')) {
      const string = word.slice(word.indexOf('<<<') + 3)
      scripts.push(string || words[k + 1] || '')
    }
  })
  return scripts
}

// The `git push` commands in `text`, wherever they sit (after a wrapper, inside `( … )` or `$(…)`,
// in a script handed to a shell), counted by `mayPush`, and whether any command there changes what
// a push reads. Compared with `pushesRead`, the count finds pushes the walk could not read.
function scanPushes(text, found = { pushes: 0, environmentChanged: false }) {
  // A command that only mentions a push counts unless nothing here could run text as a script
  // (`echo git push | sh` counts; `echo git push` does not).
  const mentionsOnly = !mayRunScripts(withoutHeredocBodies(text, true))
  for (const words of splitCommands(exposeNestedCommands(withoutComments(withoutHeredocBodies(text))))) {
    if (mayPush(words, mentionsOnly)) found.pushes += 1
    const p = programIndex(words)
    if (ENVIRONMENT_BUILTINS.has(words[p]) || (p === words.length && words.some((word) => PUSH_ENVIRONMENT.test(word)))) found.environmentChanged = true
    const g = words.findIndex((word) => path.basename(word) === 'git')
    if (g !== -1) {
      let j = g + 1
      while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1
      if (changesGitConfig(words[j], words.slice(j + 1))) found.environmentChanged = true
    }
    const scripts = nestedScripts(words)
    for (const script of scripts) scanPushes(script, found)
    // Where something can run text as a script, a quoted word may be that text
    // (`echo 'git push origin main' | bash`), or code that builds it (`os.system("git push …")`).
    if (!mentionsOnly) {
      for (const word of words) {
        if (/[\s(){}[\],]/.test(word) && !scripts.includes(word)) scanPushes(word.replace(/[(){}[\],"'`]/g, ' '), found)
      }
    }
  }
  return found
}

function withoutAllow(result) {
  return result === VERIFIED ? null : result
}

// Whether every quote in `text` closes, read as shell. Approximate: it is only compared between two
// versions of one command.
function quotesClose(text) {
  let quote = null
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
    if (quote === "'") {
      if (ch === "'") quote = null
    } else if (ch === '\\') i += 1
    else if (quote === '"') {
      if (ch === '"') quote = null
    } else if (ch === "'" || ch === '"') quote = ch
  }
  return quote === null
}

function stricter(a, b) {
  if (!a) return b
  if (!b) return a
  return a.decision === 'deny' ? a : b
}

const input = readHookInput()
if (!input) process.exit(0)
const toolName = input.tool_name || input.toolName || ''
const toolInput = input.tool_input || input.toolInput || {}
const rawCommand = toolInput.command ?? toolInput.cmd
const command = Array.isArray(rawCommand) ? rawCommand.map((w) => `'${String(w).replaceAll("'", "'\\''")}'`).join(' ') : rawCommand
// Quotes, backslashes, backslash-newlines, and brace punctuation split a word without changing what
// runs (`pu''sh`, `pu\sh`, `{push,}`), so the quick check reads the text without them. Any `$` or
// backtick can build a word the quick check cannot see (`$'pu\x73h'`, `pu$(true)sh`), so it sends
// the command to the full check. Interpreter code lists words with commas (`['git','push']`), so the
// check also reads the text with its commas kept.
// Every provider's CLI is a keyword, so a second host's commands reach the checks too.
const KEYWORDS = new RegExp(`\\b(push|${HOST_CLI_ENTRIES.map((entry) => entry.cli).join('|')}|codex|rm|rmdir|unlink|delete|xargs|clean|reset|restore|stash|merge|pull|rebase|cherry-pick|am)\\b`)
if (!SHELL_TOOLS.has(toolName) || typeof command !== 'string'
  || !(KEYWORDS.test(command.replace(/\\\n/g, '').replace(/['"\\{},]/g, ''))
    || KEYWORDS.test(command.replace(/['"\\{}]/g, '')) || /[$`]/.test(command))) process.exit(0)

const cwd = toolInput.workdir || input.cwd || process.cwd()
sessionFolders = [...new Set([cwd, input.cwd || process.cwd()])]
unsandboxed = toolInput.dangerouslyDisableSandbox === true

// Every walk reads the command without the heredoc bodies that are plainly data.
const text = withoutHeredocBodies(command)
hostIdentityChanged = changesHostIdentity(text)
// A delete's, merge's, or gh/codex launch's ask or deny outranks a verified push, so the push allow
// never covers it.
let result = stricter(stricter(classifyCommand(text, cwd), classifyDeletes(text, cwd)), classifyLaunches(text))
// The walks read a body that a program reads (`node <<'EOF'`, `bash <<EOF`) as shell, so an
// apostrophe in it can hide the commands after it. When the bodies alone unbalance the quotes and
// the rest of the command could push, delete, or merge, ask.
const skeleton = withoutHeredocBodies(command, true)
if (text !== skeleton && !quotesClose(withoutComments(text)) && quotesClose(withoutComments(skeleton))
  && KEYWORDS.test(skeleton)) {
  result = stricter(result, ask('cannot tell which commands follow this heredoc: its body unbalances the quotes the hook reads'))
}
// A push the walk could not read (wrapped, nested, aliased, or spelled by the shell) asks: no
// permission rule would.
const scanned = scanPushes(text)
if (scanned.pushes > pushesRead) {
  result = stricter(result, ask('cannot check this `git push`: it runs behind a wrapper, in a subshell, substitution, or script string, through an alias, or with words the shell fills in'))
}
// The hook reads git's configuration and environment as they are before the command runs.
if (scanned.environmentChanged && (pushesRead > 0 || scanned.pushes > 0)) {
  result = stricter(result, ask('this command changes the environment or git configuration a push reads (`export`, `unset`, `source`, a GIT_* or PATH assignment, `git config`, `git remote`, or `git branch -u`) before it pushes, so the hook cannot tell where the push lands'))
}
if (!result) process.exit(0)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}))
