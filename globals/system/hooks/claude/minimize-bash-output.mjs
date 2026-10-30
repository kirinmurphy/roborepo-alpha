import fs from 'node:fs'

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const toolInput = input.tool_input || {}
const command = toolInput.command || ''
const cwd = input.cwd || process.cwd()

const hasTail = s => /\|\s*tail\b/.test(s)
const addTail = s => hasTail(s) ? s : `${s} 2>&1 | tail -n 120`

const allow = (nextCommand, reason = 'Rewriting Bash command to a lower-noise form') => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'allow',
      permissionDecisionReason: reason,
      updatedInput: {
        ...toolInput,
        command: nextCommand
      }
    }
  }))
}

// --- Auto-approve known-safe commands, stripping a redundant leading `cd <cwd> &&` ---------
//
// The permission allowlist (settings.json) matches by LITERAL PREFIX on the whole command
// string. A leading `cd /abs/path &&` — which the agent often prepends out of habit even
// though the Bash tool already persists cwd — defeats every entry, forcing a prompt. Pipes
// and `&&` chains break matching too. This branch normalizes the command: if it is one of a
// short list of read-only / repo-local safe commands (optionally prefixed by a no-op
// `cd <cwd> &&`), strip the cd and auto-allow. `allow` cannot loosen deny/ask rules (hooks
// only tighten), so this is bounded to commands that are already safe by construction.
//
// SAFE = read-only inspection (grep/git status|diff|log/ls/cat-of-known) or this repo's own
// maintenance scripts and CLI. Anything with rm/mv/write redirection beyond /tmp is NOT here.
const SAFE_PREFIXES = [
  /^grep\b/,
  /^git (status|diff|log|show|branch)\b/,
  /^git mv\b/,
  /^ls\b/,
  /^bash scripts\/(doctor|verify-install)\.sh\b/,
  /^bash scripts\/(test\/test-cli|test\/test-install-collisions|build\/link-skills|build\/render-rules)\.sh\b/,
  /^bash scripts\/install\//,
  /^node scripts\/cli\/main\.mjs\b/,
]

// Strip a single redundant `cd <cwd> &&` (or `cd "<cwd>" &&`) at the very front. Only when the
// path equals the current working dir — i.e. the cd is provably a no-op, not a real move.
const stripRedundantCd = s => {
  const m = s.match(/^cd\s+(?:"([^"]+)"|'([^']+)'|(\S+))\s*&&\s*(.+)$/s)
  if (!m) return s
  const target = m[1] || m[2] || m[3]
  if (target === cwd) return m[4]
  return s
}

const normalized = stripRedundantCd(command.trim())
if (SAFE_PREFIXES.some(re => re.test(normalized))) {
  allow(normalized, 'Auto-approved known-safe Bash command (cd-normalized)')
  process.exit(0)
}

const deny = reason => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }))
}

// Flags count only where the shell reads them as words. Quoted strings and heredoc bodies (commit
// messages, PR bodies, grep patterns) only mention them. A flag needs whitespace or the start of the
// command before it: `\b--watch` never matches after a space, since `-` is not a word character.
const shellWords = command
  .replace(/<<-?\s*(['"]?)(\w+)\1[^\n]*\n[\s\S]*?\n\s*\2(?=\n|$)/g, '')
  .replace(/'[^']*'|"(?:\\.|[^"\\])*"/g, "''")

if (
  /(^|\s)--(watch|verbose|debug)(?=[\s=]|$)/.test(shellWords) ||
  /\b(vitest|jest|tsx|ts-node)\b.*(^|\s)(--watch|watch)(?=\s|$)/.test(shellWords)
) {
  deny('Do not use watch, verbose, or debug flags unless explicitly requested.')
  process.exit(0)
}

if (
  /\bnpm\s+run\s+lint\b/.test(command) ||
  /\bpnpm\b.*\blint\b/.test(command) ||
  /\byarn\s+lint\b/.test(command) ||
  /\bbun\s+run\s+lint\b/.test(command)
) {
  allow(addTail(command))
  process.exit(0)
}

if (
  /\bnpm\s+run\s+typecheck\b/.test(command) ||
  /\bpnpm\b.*\btypecheck\b/.test(command) ||
  /\byarn\s+typecheck\b/.test(command) ||
  /\bbun\s+run\s+typecheck\b/.test(command) ||
  /\btsc\b/.test(command)
) {
  const next = /\btsc\b/.test(command) && !/--pretty\b/.test(command)
    ? command.replace(/\btsc\b/, 'tsc --pretty false')
    : command

  allow(addTail(next))
  process.exit(0)
}

if (
  /\bnpm\s+run\s+build\b/.test(command) ||
  /\bpnpm\b.*\bbuild\b/.test(command) ||
  /\byarn\s+build\b/.test(command) ||
  /\bbun\s+run\s+build\b/.test(command) ||
  /\bnext\s+build\b/.test(command) ||
  /\bvite\s+build\b/.test(command)
) {
  allow(addTail(command))
  process.exit(0)
}

process.exit(0)
