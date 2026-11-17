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
// Covers the change-github-directly and merge-pull-requests behaviors in agent-permissions.json; a
// test keeps the first equal to this list.
const GH_DENIED = [
  ['api'], ['auth', 'token'], ['pr', 'merge'], ['repo', 'edit'], ['repo', 'delete'], ['repo', 'rename'],
  ['secret'], ['variable'], ['release'], ['workflow', 'run'],
]
// gh options that take their value as the next word, before or between subcommands.
const GH_VALUE_OPTIONS = new Set(['-R', '--repo', '--hostname'])
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
// with its escapes. Separators are ; & | && || and newlines; a backslash-newline joins lines.
// Expansion is not performed; a word that still holds $ or a backtick is reported so the caller can
// decline to classify it.
function splitCommands(text) {
  const commands = []
  let words = []
  let word = null
  let quote = null
  const endWord = () => {
    if (word !== null) words.push(word)
    word = null
  }
  const endCommand = () => {
    endWord()
    if (words.length) commands.push(words)
    words = []
  }
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]
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
      else if (ch === '\\' && i + 1 < text.length) word += text[++i]
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
    } else {
      word = (word ?? '') + ch
    }
  }
  endCommand()
  return commands
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

// gh with its options removed, matched against GH_DENIED.
function classifyGh(args) {
  const words = []
  for (let i = 0; i < args.length; i += 1) {
    if (GH_VALUE_OPTIONS.has(args[i])) i += 1
    else if (!args[i].startsWith('-')) words.push(args[i])
  }
  const denied = GH_DENIED.find((prefix) => prefix.every((word, k) => words[k] === word))
  if (!denied) return null
  return {
    decision: 'deny',
    reason: `roborepo: \`gh ${denied.join(' ')}\` acts on GitHub without going through git, so the protected-branch guards cannot check it. Run it yourself.`,
  }
}

const DELETE_PROGRAMS = new Set(['rm', 'rmdir', 'unlink'])
// Temp folders, where deletes never ask. TMPDIR covers a sandbox's per-session temp folder.
// ROBOREPO_TEMP_ROOTS (comma-separated) replaces the list.
const TEMP_ROOTS = [...new Set((process.env.ROBOREPO_TEMP_ROOTS
  ? process.env.ROBOREPO_TEMP_ROOTS.split(',')
  : ['/tmp', '/private/tmp', '/var/folders', '/private/var/folders', os.tmpdir(), process.env.TMPDIR])
  .map((root) => (root ?? '').trim().replace(/\/+$/, ''))
  .filter(Boolean)
  .flatMap((root) => [root, realDirectory(root)]))]
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

function inTemp(target) {
  return TEMP_ROOTS.some((root) => target === root || target.startsWith(`${root}/`))
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
      for (const inner of pending) out += ` ; ${SCOPE_OPEN} ; ${inner} ; ${SCOPE_CLOSE} ; `
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
        out += quote === null && /^-*[A-Za-z]+$/.test(word) ? ` ${SUBSTITUTION_PLACEHOLDER}` : SUBSTITUTION_PLACEHOLDER
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
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
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
  for (const words of splitCommands(exposeNestedCommands(text))) {
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
  for (const words of splitCommands(text)) {
    let i = 0
    while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
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
    if (program === 'gh') {
      result = stricter(result, classifyGh(words.slice(i + 1)))
      continue
    }
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

// Drops the body of every `<<` heredoc that no shell reads, so the prose of a commit message or a
// written file is not taken for commands. A body stays when its line starts a shell, `source`,
// `.`, or `eval` (`bash <<EOF`, `cat <<EOF | sh`). Quotes, `$(…)`, backticks, and comments are
// tracked so a `<<` inside a string is not taken for a heredoc, and a body whose closing line never
// appears is kept, so a misread can only keep text.
function withoutHeredocBodies(text) {
  let out = ''
  const open = [] // quotes and substitutions still open: ' $' " $( ( `
  let pending = []
  let i = 0
  const shellReads = (line) => line.split(/[;&|(`\n]|\$\(/).some((part) => {
    const words = part.trim().split(/\s+/).map((word) => word.replace(/['"\\]/g, ''))
    const program = words[programIndex(words)]
    return Boolean(program) && (SHELLS.has(path.basename(program)) || ['source', '.', 'eval'].includes(program))
  })
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
      for (; k < text.length; k += 1) {
        const c = text[k]
        if (quote) {
          if (c === quote) quote = null
          else delimiter += c
        } else if (c === "'" || c === '"') quote = c
        else if (c === '\\' && k + 1 < text.length) delimiter += text[++k]
        else if (/[\s;&|<>()]/.test(c)) break
        else delimiter += c
      }
      if (delimiter && !quote) {
        const lineStart = out.lastIndexOf('\n') + 1
        const lineEnd = text.indexOf('\n', k)
        pending.push({ delimiter, stripTabs, kept: shellReads(out.slice(lineStart) + text.slice(i, lineEnd === -1 ? text.length : lineEnd)) })
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
        if (heredoc.kept) out += text.slice(i, closing)
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
const ENVIRONMENT_BUILTINS = new Set(['export', 'unset', 'declare', 'typeset'])
const PUSH_ENVIRONMENT = /^(GIT_[A-Za-z0-9_]*|HOME|XDG_CONFIG_HOME|PATH)\+?=/

function changesGitConfig(subcommand, args) {
  if (subcommand === 'config') {
    // A lookup (`git config --get x`, `git config x`) changes nothing; a value, an edit, or a
    // removal does.
    const operands = args.filter((arg) => !arg.startsWith('-'))
    return operands.length >= 2 || ['set', 'unset', 'edit', 'rename-section', 'remove-section'].includes(operands[0])
      || args.some((arg) => /^(--(add|unset|unset-all|replace-all|rename-section|remove-section|edit)|-e)$/.test(arg))
  }
  if (subcommand === 'remote') return ['add', 'set-url', 'set-head', 'rename', 'remove', 'rm', 'set-branches'].includes(args.find((arg) => !arg.startsWith('-')))
  if (subcommand === 'branch') return args.some((arg) => arg.startsWith('--set-upstream-to') || /^-[A-Za-z]*u/.test(arg))
  return false
}

// Whether one simple command may run `git push` in a form the walk cannot read: a git word followed
// by a `push` word, a `git -c alias.*` that could define one, a brace word that expands to push
// (`git {push,}`), a subcommand the shell fills in (`git $CMD`, `git $(…)`), `xargs git` with its
// subcommand on stdin, or a program the shell fills in followed by a push word (`$GIT push`).
function mayPush(words) {
  const g = words.findIndex((word) => path.basename(word) === 'git')
  if (g !== -1) {
    const after = words.slice(g + 1)
    if (after.includes('push') || words.some((word) => word.startsWith('alias.'))) return true
    if (after.some((word) => !word.startsWith('-') && word.includes('{') && word.replace(/[{},]/g, '').includes('push'))) return true
    let j = g + 1
    while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1
    if (/[$`]/.test(words[j] ?? '')) return true
    if (words.slice(0, g).some((word) => path.basename(word) === 'xargs') && !/^[a-z][a-z0-9-]*$/.test(words[j] ?? '')) return true
  }
  const p = programIndex(words)
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
  for (const words of splitCommands(exposeNestedCommands(withoutHeredocBodies(text)))) {
    if (mayPush(words)) found.pushes += 1
    const p = programIndex(words)
    if (ENVIRONMENT_BUILTINS.has(words[p]) || (p === words.length && words.some((word) => PUSH_ENVIRONMENT.test(word)))) found.environmentChanged = true
    const g = words.findIndex((word) => path.basename(word) === 'git')
    if (g !== -1) {
      let j = g + 1
      while (j < words.length && words[j].startsWith('-')) j += GIT_VALUE_OPTIONS.has(words[j]) ? 2 : 1
      if (changesGitConfig(words[j], words.slice(j + 1))) found.environmentChanged = true
    }
    for (const script of nestedScripts(words)) scanPushes(script, found)
  }
  return found
}

function withoutAllow(result) {
  return result === VERIFIED ? null : result
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
// Quotes, backslashes, and brace punctuation split a word without changing what runs (`pu''sh`,
// `pu\sh`, `{push,}`), so the quick check reads the text without them; a `$'…'` string can spell any
// word with escapes, so it always gets the full check.
const KEYWORDS = /\b(push|gh|rm|rmdir|unlink|delete|xargs|clean|reset|restore|stash|merge|pull|rebase|cherry-pick|am)\b/
if (!SHELL_TOOLS.has(toolName) || typeof command !== 'string' || !(KEYWORDS.test(command.replace(/['"\\{},]/g, '')) || command.includes("$'"))) process.exit(0)

const cwd = toolInput.workdir || input.cwd || process.cwd()
unsandboxed = toolInput.dangerouslyDisableSandbox === true
// A delete's or merge's ask or deny outranks a verified push, so the push allow never covers it.
let result = stricter(classifyCommand(command, cwd), classifyDeletes(command, cwd))
// A push the walk could not read (wrapped, nested, aliased, or spelled by the shell) asks: no
// permission rule would.
const scanned = scanPushes(command)
if (scanned.pushes > pushesRead) {
  result = stricter(result, ask('cannot check this `git push`: it runs behind a wrapper, in a subshell, substitution, or script string, through an alias, or with words the shell fills in'))
}
// The hook reads git's configuration and environment as they are before the command runs.
if (scanned.environmentChanged && (pushesRead > 0 || scanned.pushes > 0)) {
  result = stricter(result, ask('this command changes the environment or git configuration a push reads (`export`, `unset`, a GIT_* or PATH assignment, `git config`, `git remote`, or `git branch -u`) before it pushes, so the hook cannot tell where the push lands'))
}
if (!result) process.exit(0)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}))
