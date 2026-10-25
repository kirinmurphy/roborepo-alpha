import fs from 'node:fs'

// --- Minimize Codex shell output (PreToolUse) ----------------------------------------------------
//
// Codex parallel of globals/claude/hooks/minimize-bash-output.mjs. Codex's shell output is uncapped
// by default, which telemetry showed to be the dominant token cost (~22.8M tok of Bash results vs
// 49K on Claude, where this minimization already runs). Codex PreToolUse hooks support the same
// hookSpecificOutput { permissionDecision, updatedInput } protocol as Claude (verified against the
// codex 0.141 wire schema), and pass the same tool_name / tool_input fields the telemetry capture
// hook already relies on.
//
// Behavior mirrors the Claude hook's output-minimization half EXACTLY: append `2>&1 | tail -n 120`
// to noisy build/lint/typecheck commands, force `tsc --pretty false`, and deny watch/verbose/debug
// flags. It deliberately does NOT include the Claude SAFE_PREFIXES cd-normalization branch — that
// targets Claude's settings.json literal-prefix permission matching and is Claude-specific.

function readHookInput() {
  let text = ''
  try {
    text = fs.readFileSync(0, 'utf8')
  } catch {
    return null
  }
  if (!text.trim()) return null
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

const input = readHookInput()
if (!input) process.exit(0)
const toolName = input.tool_name || input.toolName || input.tool || ''
const toolInput = input.tool_input || input.toolInput || {}
const command = toolInput.command || ''

// Codex's shell tool goes by a few names depending on version/config. Act only on those; anything
// else passes through untouched.
const SHELL_TOOLS = new Set(['exec_command', 'shell', 'local_shell', 'bash'])
if (!SHELL_TOOLS.has(toolName) || typeof command !== 'string' || !command) {
  process.exit(0)
}

const hasTail = s => /\|\s*tail\b/.test(s)
const addTail = s => hasTail(s) ? s : `${s} 2>&1 | tail -n 120`

const allow = (nextCommand, reason = 'Rewriting shell command to a lower-noise form') => {
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

const deny = reason => {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason: reason
    }
  }))
}

if (
  /\b(--watch|--verbose|--debug)\b/.test(command) ||
  /\b(vitest|jest|tsx|ts-node)\b.*\b(--watch|watch)\b/.test(command)
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
