import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

// --- Real per-command ask on Codex, via a PreToolUse hook ---------------------------------------
//
// Codex's shell prefix rules (globals/codex/rules/default.rules) are binary — forbidden/allow only,
// confirmed against the shipped Codex 0.140 wire schema (`strings` on the compiled binary): the
// PreToolUseDecisionWire enum used by the OLDER approve/block mechanism is 2-valued, but the
// CURRENT one — PreToolUsePermissionDecisionWire, the one hookSpecificOutput.permissionDecision
// actually serializes to — has THREE values: allow, deny, ask. Codex hooks can genuinely prompt
// per-command, the same as Claude; `prefix_rule` alone just can't express it. This hook is the
// missing piece: it re-implements the manifest's command matching at runtime and emits a real
// permissionDecision for any command that matches a deny/ask/allow-bucketed behavior or arbitrary
// command, closing the gap `renderCodexRules` leaves (which must omit a rule entirely for "ask").
//
// Unmatched commands: no hookSpecificOutput is emitted, so the tool call falls through unchanged
// to whatever `approval_policy` and any other PreToolUse hook decide — this hook only tightens
// (or clarifies) the classified subset, mirroring the "hooks only tighten" convention already
// documented in minimize-bash-output.mjs.

// The state root resolves the way the CLI's own does. The app root the CLI records there is what an
// npm install depends on: this file runs as a copy under the harness home, so walking back from its
// own location only finds the manifest in a development checkout.
const stateDir =
  process.env.ROBOREPO_STATE_ROOT || process.env.ROBOREPO_STATE_DIR || path.join(os.homedir(), '.roborepo')

function candidateRepoRoots() {
  const candidates = []
  if (process.env.REPO_ROOT) candidates.push(process.env.REPO_ROOT)

  for (const [file, key] of [['app-root.json', 'appRoot'], ['install-state.json', 'repo']]) {
    try {
      const value = JSON.parse(fs.readFileSync(path.join(stateDir, file), 'utf8'))[key]
      if (typeof value === 'string' && value) candidates.push(value)
    } catch {}
  }

  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'))
  return candidates
}

function hasPermissionManifest(root) {
  return fs.existsSync(path.join(root, 'manifests', 'inventory', 'agent-permissions.json'))
}

const candidates = candidateRepoRoots()
const repoRoot = candidates.find(hasPermissionManifest) || candidates[candidates.length - 1]
const manifestPath = path.join(repoRoot, 'manifests', 'inventory', 'agent-permissions.json')
const overridesPath = path.join(stateDir, 'command-overrides.json')
const permissionManifestFound = hasPermissionManifest(repoRoot)

function loadJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

const manifest = loadJson(manifestPath, { behaviors: [], commands: { allow: [] } })
const overrides = loadJson(overridesPath, { behaviors: {}, commands: {} })

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

// Same merge semantics as permissions-render.mjs's resolveBehaviors/resolveArbitraryCommands, but
// this hook can't import that module directly — it must run standalone with only Node builtins
// (no repo-relative package resolution guaranteed from every Codex install layout). Duplicated
// deliberately small and pure; keep in sync if the override-file shape changes.
function resolveBehaviors() {
  return (manifest.behaviors ?? []).map((b) => ({
    ...b,
    bucket: overrides.behaviors?.[b.id] ?? b.bucket,
  }))
}

function resolveArbitraryCommands() {
  const byKey = new Map()
  for (const tokens of manifest.commands?.allow ?? []) {
    byKey.set(tokens.map(String).join(' '), { tokens, bucket: 'allow' })
  }
  for (const [key, entry] of Object.entries(overrides.commands ?? {})) {
    byKey.set(key, { tokens: entry.tokens, bucket: entry.bucket })
  }
  return [...byKey.values()]
}

// Every command-kind behavior/arbitrary entry, flattened to { tokens, bucket }, sorted longest-
// prefix-first so a more specific rule (e.g. ["git", "push"]) is checked before a shorter one that
// could otherwise shadow it (there are none today, but this keeps the matcher correct as the list
// grows).
function allCommandRules() {
  const rules = []
  for (const b of resolveBehaviors()) {
    if (b.kind !== 'commands') continue
    for (const tokens of b.commands ?? []) rules.push({ tokens, bucket: b.bucket })
  }
  for (const c of resolveArbitraryCommands()) rules.push({ tokens: c.tokens, bucket: c.bucket })
  return rules.sort((a, z) => z.tokens.length - a.tokens.length)
}

// Literal-prefix match: every rule token must appear, in order, as the leading words of the
// command. Mirrors Claude's `Bash(a b:*)` prefix semantics (commandToClaude in
// permissions-render.mjs) so a command classified once behaves the same on both harnesses.
function matchesPrefix(commandTokens, ruleTokens) {
  if (ruleTokens.length > commandTokens.length) return false
  return ruleTokens.every((t, i) => commandTokens[i] === t)
}

const input = readHookInput()
if (!input) process.exit(0)
const toolName = input.tool_name || input.toolName || input.tool || ''
const toolInput = input.tool_input || input.toolInput || {}
const command = typeof toolInput.command === 'string' ? toolInput.command : ''

const SHELL_TOOLS = new Set(['exec_command', 'shell', 'local_shell', 'bash'])
if (!SHELL_TOOLS.has(toolName) || !command) process.exit(0)

if (!permissionManifestFound) {
  process.stdout.write(JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'ask',
      permissionDecisionReason: `roborepo permissions: manifest not found at ${manifestPath}`,
    },
  }))
  process.exit(0)
}

// Simple whitespace tokenization — matches how the manifest's own command patterns are authored
// (space-separated argv-style arrays). A command with a pipe or `&&` is deliberately NOT split
// further here: it's tokenized as one flat word list, so a rule like ["git","push"] still matches
// `git push origin main` but won't falsely match `echo hi && git push` (the leading tokens are
// `echo hi && git push...`, not `git push...`) — consistent with "we only tighten what we can
// confidently classify," matching the same conservative stance minimize-bash-output.mjs documents.
const commandTokens = command.trim().split(/\s+/)

const rule = allCommandRules().find((r) => matchesPrefix(commandTokens, r.tokens))
if (!rule) process.exit(0) // unclassified — fall through to approval_policy / other hooks

process.stdout.write(JSON.stringify({
  hookSpecificOutput: {
    hookEventName: 'PreToolUse',
    permissionDecision: rule.bucket,
    permissionDecisionReason: `roborepo permissions: "${rule.tokens.join(' ')}" is ${rule.bucket}`,
  },
}))