import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// --- Capture dense (multi-line) Bash tool calls for later pattern analysis -----------------
//
// PURPOSE: collect the super-dense, multi-line shell commands the agent emits so their
// patterns can be analyzed and engineered away (turned into scripts, CLI subcommands, or
// allowlist entries). This hook ONLY observes — it never blocks, rewrites, or prompts. It
// shares the PreToolUse:Bash chain with minimize-bash-output.mjs and must stay a silent
// passthrough so it cannot perturb that hook's decisions.
//
// FLAG RULE: a command is "dense" when it spans >= DENSE_LINE_THRESHOLD lines (newline count).
// That matches the "3+ newlines" capture rule, catching the 2-3-line-plus commands that are
// hard to read and hard to allowlist.
//
// wouldPrompt: best-effort guess at whether this command would have hit a permission prompt,
// computed by re-reading ~/.claude/settings.json and prefix-matching against allow/deny the
// way Claude's matcher does. It is approximate (does not model ask-rules, project settings,
// or session-mode overrides) and is recorded as a FIELD, not used to gate capture — so the
// log can later be filtered to "dense AND would-prompt" without this hook being fragile.

const DENSE_LINE_THRESHOLD = 3
const LONG_COMMAND_CHARS = 160

// A command is worth capturing when it is hard to READ or impossible to ALLOWLIST — not merely
// when it is multi-line. The original newline-only rule missed the most common offenders, which
// are single-line: `cd x && echo "=== y ===" && cmd`. Each clause below marks one property that
// defeats prefix matching, so the log can be filtered by which one fired.
function densityReasons(cmd) {
  const reasons = []
  if (cmd.split('\n').length >= DENSE_LINE_THRESHOLD) reasons.push('multiline')
  // Composition: a chained string can never match a `Bash(head:*)` prefix rule.
  if (/&&|\|\||;/.test(cmd)) reasons.push('chained')
  // A leading `cd` makes every command in that directory unmatchable.
  if (/^\s*cd\s/.test(cmd)) reasons.push('leading-cd')
  // Decorative headers/trailers: pure noise that makes the string unrepeatable.
  if (/echo\s+["']?(===|---|\w+=\$\?)/.test(cmd)) reasons.push('echo-decoration')
  // Inline env assignment before the binary defeats prefix matching like `cd` does.
  if (/^\s*[A-Z_][A-Z0-9_]*=/.test(cmd)) reasons.push('inline-env')
  if (cmd.length > LONG_COMMAND_CHARS) reasons.push('long')
  return reasons
}

const fail = () => process.exit(0) // any error => silent passthrough, never disturb the call

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  fail()
}

const toolInput = input.tool_input || {}
const command = typeof toolInput.command === 'string' ? toolInput.command : ''
if (!command) fail()

const lineCount = command.split('\n').length
const reasons = densityReasons(command)
if (reasons.length === 0) process.exit(0) // ordinary, allowlistable command — nothing to capture

// --- Best-effort allowlist match ---------------------------------------------------------
// Claude matches Bash permissions by literal prefix inside `Bash(<prefix>)`, where a trailing
// `:*` means prefix-match and no `:*` means the command must equal the prefix exactly. We
// approximate that. deny wins over allow.
const matchesRule = (cmd, rule) => {
  const m = rule.match(/^Bash\((.*)\)$/s)
  if (!m) return false
  const pat = m[1]
  if (pat.endsWith(':*')) return cmd.startsWith(pat.slice(0, -2))
  return cmd === pat
}

let wouldPrompt = null // null = could not determine
try {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
  const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
  const perms = settings.permissions || {}
  const allow = Array.isArray(perms.allow) ? perms.allow : []
  const deny = Array.isArray(perms.deny) ? perms.deny : []
  const trimmed = command.trim()
  const denied = deny.some(r => matchesRule(trimmed, r))
  const allowed = allow.some(r => matchesRule(trimmed, r))
  // Denied commands are auto-rejected (no prompt); allowed are auto-run (no prompt);
  // everything else prompts.
  wouldPrompt = !denied && !allowed
} catch {
  wouldPrompt = null
}

const record = {
  ts: new Date().toISOString(),
  session_id: input.session_id || null,
  cwd: input.cwd || null,
  lineCount,
  charCount: command.length,
  reasons,
  wouldPrompt,
  command,
}

// Persist to a single stable file per harness so dense-command patterns accumulate ACROSS sessions
// and survive reboots — the whole point is to mine the corpus later. session_id is a field on each
// record, so collapsing to one file loses nothing.
//
// This hook runs as a copied runtime asset in ~/.claude/hooks/, outside the CLI's module graph, so
// it cannot import scripts/cli/state-paths.mjs. It re-resolves STATE_ROOT with the same env
// precedence instead, matching usage-snapshot-store.mjs, which solves the identical problem. The
// path must stay in agreement with denseBashLogPath(); a test asserts it under a sandboxed root.
function STATE_ROOT() {
  return (
    process.env.ROBOREPO_STATE_ROOT ||
    path.join(os.homedir(), '.roborepo')
  )
}

const MAX_BYTES = 10 * 1024 * 1024
const MAX_AGE_DAYS = 30
const FLOOR_BYTES = 64 * 1024
const KEEP_FRACTION = 0.7

try {
  const logPath = path.join(STATE_ROOT(), 'capture', 'claude', 'dense-bash.jsonl')
  fs.mkdirSync(path.dirname(logPath), { recursive: true })
  fs.appendFileSync(logPath, JSON.stringify(record) + '\n')
  capLog(logPath)
} catch {
  // swallow — observation must never break the tool call
}

// Bound the log the same way modules/retention does, reimplemented here for the same reason the
// path is: this file cannot import from the CLI. The policy numbers mirror the capture-dense-bash
// entry in modules/retention/registry.mjs.
//
// Cheap by construction: stat first, skip below the floor, and only read the file when it is
// actually over the cap or its oldest record has expired. keepFraction overshoots on trim so this
// does not re-trip on the very next command.
function capLog(logPath) {
  let size
  try {
    size = fs.statSync(logPath).size
  } catch {
    return
  }
  if (size <= FLOOR_BYTES) return

  const cutoff = Date.now() - MAX_AGE_DAYS * 24 * 60 * 60 * 1000
  if (size <= MAX_BYTES && !oldestExpired(logPath, cutoff)) return

  let lines
  try {
    lines = fs.readFileSync(logPath, 'utf8').split('\n').filter(l => l.trim())
  } catch {
    return
  }

  // Age first (the meaningful policy), then bytes as the backstop. Records are appended in time
  // order, so expiry is a prefix — stop at the first live record rather than filtering, so a
  // hand-edited or clock-skewed line cannot strand everything after it.
  let dropped = 0
  while (dropped < lines.length - 1) {
    const at = tsOf(lines[dropped])
    if (at === null || at >= cutoff) break
    dropped += 1
  }

  let remaining = lines.slice(dropped)
  let bytes = remaining.reduce((sum, line) => sum + Buffer.byteLength(line, 'utf8') + 1, 0)
  if (bytes > MAX_BYTES) {
    const target = Math.floor(MAX_BYTES * KEEP_FRACTION)
    let extra = 0
    while (extra < remaining.length - 1 && bytes > target) {
      bytes -= Buffer.byteLength(remaining[extra], 'utf8') + 1
      extra += 1
    }
    remaining = remaining.slice(extra)
    dropped += extra
  }
  if (dropped === 0) return

  try {
    fs.writeFileSync(logPath, remaining.join('\n') + '\n')
  } catch {
    // Best-effort: a failed trim just leaves the file large until the next capture.
  }
}

function oldestExpired(logPath, cutoff) {
  let head
  try {
    const fd = fs.openSync(logPath, 'r')
    try {
      const buffer = Buffer.alloc(4096)
      const read = fs.readSync(fd, buffer, 0, 4096, 0)
      head = buffer.subarray(0, read).toString('utf8').split('\n', 1)[0]
    } finally {
      fs.closeSync(fd)
    }
  } catch {
    return true
  }
  const at = tsOf(head)
  return at === null ? true : at < cutoff
}

function tsOf(line) {
  try {
    const parsed = Date.parse(JSON.parse(line).ts)
    return Number.isFinite(parsed) ? parsed : null
  } catch {
    return null
  }
}

process.exit(0)
