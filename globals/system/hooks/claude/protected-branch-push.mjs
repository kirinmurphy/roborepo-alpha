import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Decides agent `git push` commands, which the permission rules leave at "ask". A permission
// prefix rule cannot tell them apart: `git push` on main, `git push origin HEAD:main`, and
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
// It also denies the gh commands that act on GitHub without git (API calls, the token, settings) in
// the forms the permission prefix rules miss: global flags before the subcommand, as in
// `gh -R owner/repo api …`. Those never reach either protected-branch guard.
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
// Mirrors the change-github-directly behavior in agent-permissions.json; a test keeps them equal.
// `gh pr merge` is absent: merge-pull-requests asks, so the permission rules decide it.
const GH_DENIED = [
  ['api'], ['auth', 'token'], ['repo', 'edit'], ['repo', 'delete'], ['repo', 'rename'],
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

// Splits a shell command into simple commands (word lists), honoring quotes. Separators are
// ; & | && || and newlines. Expansion is not performed; a word that still holds $ or a backtick
// is reported so the caller can decline to classify it.
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
    } else if (quote === '"') {
      if (ch === '"') quote = null
      else if (ch === '\\' && i + 1 < text.length) word += text[++i]
      else word += ch
    } else if (ch === "'" || ch === '"') {
      quote = ch
      word ??= ''
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
    if (/[<>]/.test(arg)) return null
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
    // A delete of a non-protected branch is left to the permission prompt.
    if (deleteFlag) return null
    if (git(cwd, ['config', 'push.default']) === 'matching') return ask('push.default is "matching", which can include a protected branch')
    if (mapped) return ask(`remote.${remote}.push is configured; cannot tell where this push lands`)
    const target = implicitDestination(cwd)
    if (target && protectedNames.has(target)) return deny(target, `\`git push\` from ${branch || 'this branch'} writes to ${remote}/${target}`)
    return defaultKnown ? VERIFIED : unknownDefault(remote)
  }

  for (const refspec of words) {
    if (refspec.includes('*')) return ask(`refspec \`${refspec}\` is a pattern and can include a protected branch`)
    if (refspec === ':') return ask('refspec `:` pushes every branch that also exists on the remote')
    if (mapped && !deleteFlag && !refspec.includes(':')) return ask(`remote.${remote}.push is configured, so \`${refspec}\` may not land on a branch of that name`)
    const destination = deleteFlag ? { branch: refspec.replace(/^refs\/heads\//, ''), deleting: true } : refspecDestination(cwd, refspec)
    if (destination && protectedNames.has(destination.branch)) {
      const verb = destination.deleting ? 'deletes' : 'writes to'
      return deny(destination.branch, `\`${refspec}\` ${verb} ${remote}/${destination.branch}`)
    }
  }
  if (deleteFlag) return null
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
  .filter(Boolean))]
// Shell words that start a command without being its program.
const SHELL_KEYWORDS = new Set(['if', 'then', 'else', 'elif', 'do', 'while', 'until', '!', '{', '}', 'time', 'exec', 'command', 'builtin', 'nohup', 'nice', 'sudo', 'env'])
// Options of those wrappers that take the next word as their value.
const WRAPPER_VALUE_OPTIONS = new Set(['-n', '-u', '-g', '-C', '-p', '-S', '-r', '-t'])
// xargs options that take the next word as their value.
const XARGS_VALUE_OPTIONS = new Set(['-n', '-I', '-i', '-P', '-L', '-l', '-s', '-d', '-E', '-e', '-a', '--max-args', '--max-procs', '--max-lines', '--delimiter', '--arg-file', '--replace'])
// How far below a deleted folder to look for a checkout on a protected branch.
const CONTAINED_CHECKOUT_DEPTH = 2
const checkoutCache = new Map()

function inTemp(target) {
  return TEMP_ROOTS.some((root) => target === root || target.startsWith(`${root}/`))
}

// The checkout holding `dir` when it has a protected branch checked out, else null.
function checkoutAt(dir) {
  if (checkoutCache.has(dir)) return checkoutCache.get(dir)
  let found = null
  const top = git(dir, ['rev-parse', '--show-toplevel'])
  const branch = top && currentBranch(dir)
  if (branch && protectedBranches(dir, defaultRemote(dir, branch)).names.has(branch)) found = { top, branch }
  checkoutCache.set(dir, found)
  return found
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
  if (/^\$\{?TMPDIR\}?(\/|$)/.test(word)) return process.env.TMPDIR || os.tmpdir()
  const home = /^~(\/|$)/.test(word) ? os.homedir() + word.slice(1) : word
  const literal = home.split(/[$`*?[{]/)[0]
  if (literal === home) return path.resolve(cwd, home)
  if (!literal) return cwd
  return path.resolve(cwd, literal.endsWith('/') ? literal : path.dirname(literal))
}

// Asks when any target lies in, or holds, a checkout on a protected branch.
function classifyDelete(cwd, command, targets) {
  for (const word of targets.length ? targets : ['.']) {
    const target = operandPath(cwd, word)
    if (inTemp(target)) continue
    const checkout = protectedCheckout(target)
    if (checkout) return askDelete(command, checkout)
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
function findDeleteTargets(args) {
  const deletes = args.includes('-delete') || args.some((arg, k) => ['-exec', '-execdir'].includes(arg) && DELETE_PROGRAMS.has(path.basename(args[k + 1] ?? '')))
  if (!deletes) return null
  const first = args.findIndex((arg) => arg.startsWith('-') || arg === '(' || arg === '!')
  return first === -1 ? args : args.slice(0, first)
}

// The program xargs runs: the first word after its options and their values.
function xargsProgram(args) {
  for (let k = 0; k < args.length; k += 1) {
    const arg = args[k]
    if (XARGS_VALUE_OPTIONS.has(arg)) k += 1
    else if (!arg.startsWith('-')) return arg
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

// Walks every simple command looking for deletes, following `cd`, `cd -`, `pushd`, and `popd`,
// shell keywords and wrappers (`if … then rm`, `env rm`, `sudo rm`), subshells and command
// substitutions (each with its own working folder), and `sh -c`.
function classifyDeletes(text, startCwd) {
  let cwd = startCwd
  let previous = startCwd
  const dirStack = []
  const scopes = []
  let result = null
  // A move the walk cannot follow still makes the current folder the shell's previous one, so a
  // later `cd -` returns there; the walk itself stays put.
  const moveTo = (next) => {
    previous = cwd
    if (next !== null) cwd = next
  }
  for (const words of splitCommands(exposeNestedCommands(text))) {
    if (words[0] === SCOPE_OPEN) {
      scopes.push({ cwd, previous, stack: dirStack.slice() })
      continue
    }
    if (words[0] === SCOPE_CLOSE) {
      const scope = scopes.pop()
      if (scope) {
        ;({ cwd, previous } = scope)
        dirStack.splice(0, dirStack.length, ...scope.stack)
      }
      continue
    }
    let i = 0
    for (;;) {
      while (i < words.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(words[i])) i += 1
      if (!SHELL_KEYWORDS.has(words[i])) break
      i += 1
      while (i < words.length && words[i].startsWith('-')) i += WRAPPER_VALUE_OPTIONS.has(words[i]) ? 2 : 1
    }
    const program = words[i] && path.basename(words[i])
    const args = words.slice(i + 1)
    const dirArgs = ['cd', 'pushd'].includes(program) ? withoutRedirects(args) : args
    // Only redirect-looking words: `cd ">x"` loses its quotes before this, so its target is unknown.
    const onlyRedirects = args.length > 0 && dirArgs.length === 0
    if (program === 'cd' && dirArgs.length === 1 && dirArgs[0] === '-') {
      moveTo(previous)
    } else if (program === 'cd') {
      moveTo(onlyRedirects ? null : changedDirectory(cwd, dirArgs))
    } else if (program === 'pushd' && dirArgs.length === 0) {
      // Bare `pushd` swaps the current folder with the top of the stack.
      if (dirStack.length) {
        const top = dirStack.pop()
        dirStack.push(cwd)
        moveTo(top)
      }
    } else if (program === 'pushd') {
      dirStack.push(cwd)
      moveTo(onlyRedirects ? null : changedDirectory(cwd, dirArgs))
    } else if (program === 'popd') {
      if (dirStack.length) moveTo(dirStack.pop())
    } else if (SHELLS.has(program)) {
      const flag = args.findIndex((w) => /^-[a-z]*c[a-z]*$/.test(w))
      if (flag !== -1 && args[flag + 1]) result = stricter(result, classifyDeletes(args[flag + 1], cwd))
    } else if (DELETE_PROGRAMS.has(program)) {
      result = stricter(result, classifyDelete(cwd, program, deleteTargets(args)))
    } else if (program === 'find') {
      const targets = findDeleteTargets(args)
      if (targets) result = stricter(result, classifyDelete(cwd, 'find -delete', targets))
    } else if (program === 'xargs') {
      // The paths arrive on stdin, so the directory xargs runs in stands in for them.
      const deleter = xargsProgram(args)
      if (deleter && DELETE_PROGRAMS.has(path.basename(deleter))) result = stricter(result, classifyDelete(cwd, `xargs ${deleter}`, []))
    } else if (program === 'git') {
      let gitCwd = cwd
      let j = 0
      while (j < args.length && args[j].startsWith('-')) {
        if (args[j] === '-C') {
          gitCwd = path.resolve(gitCwd, args[j + 1] ?? '')
          j += 2
        } else j += ['-c', '--git-dir', '--work-tree', '--namespace'].includes(args[j]) ? 2 : 1
      }
      const deletes = args[j] && gitDeletes(args[j], args.slice(j + 1))
      if (deletes) result = stricter(result, classifyDelete(gitCwd, deletes, []))
    }
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

// Walks every simple command, following `cd` so a later `git push` is resolved in the right
// directory, and descending into `sh -c '...'` strings. A deny or ask from any push wins. The result
// is VERIFIED only when every simple command is a `cd` or a verified push run plainly: no leading
// environment assignment and no `git -c` (either could point git away from the backstop), and not
// inside a shell wrapper.
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
    const pushResult = classifyPush(gitCwd, words.slice(j + 1))
    if (pushResult !== VERIFIED || !plain || configured) onlyVerifiedPushes = false
    result = stricter(result, withoutAllow(pushResult))
  }
  if (result) return result
  return onlyVerifiedPushes && backstopInstalled() ? VERIFIED : null
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
if (!SHELL_TOOLS.has(toolName) || typeof command !== 'string' || !/\b(push|gh|rm|rmdir|unlink|delete|xargs|clean|reset|restore|stash)\b/.test(command)) process.exit(0)

const cwd = toolInput.workdir || input.cwd || process.cwd()
// A delete's ask or deny outranks a verified push, so the push allow never covers a chained delete.
const result = stricter(classifyCommand(command, cwd), classifyDeletes(command, cwd))
if (!result) process.exit(0)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}))
