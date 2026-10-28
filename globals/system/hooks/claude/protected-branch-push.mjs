import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Decides agent `git push` commands, which the permission rules leave at "ask". A permission
// prefix rule cannot tell them apart: `git push` on main, `git push origin HEAD:main`, and
// `git push origin :main` all start with the same words as a feature-branch push.
//
// Protected: main, master, the remote's default branch (refs/remotes/<remote>/HEAD), and any names in
// ROBOREPO_PROTECTED_BRANCHES (comma-separated). A push that lands on one is denied, and so is any
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
// The same file is installed for Claude and Codex; both send PreToolUse input on stdin and accept
// hookSpecificOutput.permissionDecision. Keep the two copies identical.

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'bash'])
const SHELLS = new Set(['sh', 'bash', 'zsh'])
// git push options that take their value as the next word.
const VALUE_OPTIONS = new Set(['--repo', '-o', '--push-option', '--receive-pack', '--exec'])
const UNCLASSIFIABLE_OPTIONS = new Set(['--all', '--branches', '--mirror'])
// Skips the pre-push backstop, so a push carrying it is never allowed without a prompt.
const SKIPS_BACKSTOP = new Set(['--no-verify'])
const VERIFIED = { decision: 'allow', reason: 'roborepo: push to a non-protected branch, checked by the protected-branch hooks.' }
const gitHooksDir = process.env.ROBOREPO_GIT_HOOKS_DIR
  || path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'git-hooks')

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
  const names = new Set(['main', 'master'])
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

function unknownDefault(remote) {
  return ask(`the default branch of \`${remote}\` is not recorded here, so this push may land on it. \`git remote set-head ${remote} --auto\` records it`)
}

function deny(branch, detail) {
  return {
    decision: 'deny',
    reason: `roborepo: pushing to protected branch "${branch}" is blocked for agents (${detail}). Push a feature branch and open a pull request instead.`,
  }
}

function denyForce(what) {
  return {
    decision: 'deny',
    reason: `roborepo: force pushes are blocked for agents (${what} rewrites published history). Push without force, or run it yourself.`,
  }
}

function ask(detail) {
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
if (!SHELL_TOOLS.has(toolName) || typeof command !== 'string' || !/\bpush\b/.test(command)) process.exit(0)

const cwd = toolInput.workdir || input.cwd || process.cwd()
const result = classifyCommand(command, cwd)
if (!result) process.exit(0)

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: result.decision,
    permissionDecisionReason: result.reason,
  },
}))
