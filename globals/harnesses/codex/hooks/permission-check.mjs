import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

// Native prefix rules own command approval requests; PreToolUse cannot return "ask".
// The approval event may approve only a verified generic push. Routine allows must not
// approve unrelated filesystem/network escalations, and personal ask overrides must still prompt.

// The state root resolves the way the CLI's own does. The app root the CLI records there is what an
// npm install depends on: this file runs as a copy under the harness home, so walking back from its
// own location only finds the manifest in a development checkout.
const stateDir =
  process.env.ROBOREPO_STATE_ROOT || path.join(os.homedir(), '.roborepo')

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
    for (const tokens of b.commands ?? []) rules.push({ tokens, bucket: b.bucket, behaviorId: b.id })
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

function verifiedPushDecision(input) {
  const hook = path.join(path.dirname(fileURLToPath(import.meta.url)), 'protected-branch-push.mjs')
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input), encoding: 'utf8', timeout: 10000,
  })
  if (result.status !== 0) return null
  try {
    const output = JSON.parse(result.stdout).hookSpecificOutput
    return ['allow', 'deny'].includes(output?.permissionDecision)
      && typeof output.permissionDecisionReason === 'string' ? output : null
  } catch {
    return null
  }
}

const input = readHookInput()
if (!input) process.exit(0)
const toolName = input.tool_name || input.toolName || input.tool || ''
const toolInput = input.tool_input || input.toolInput || {}
// Desktop shell calls arrive as Bash/command; exec_command uses cmd.
const rawCommand = toolInput.command ?? toolInput.cmd
const command = typeof rawCommand === 'string' ? rawCommand : ''

const SHELL_TOOLS = new Set(['Bash', 'exec_command', 'shell', 'local_shell', 'bash'])
if (!SHELL_TOOLS.has(toolName) || !command) process.exit(0)

const approvalRequest = input.hook_event_name === 'PermissionRequest'

function respond(decision, reason) {
  const output = approvalRequest
    ? { hookEventName: 'PermissionRequest', decision: { behavior: decision, ...(decision === 'deny' ? { message: reason } : {}) } }
    : { hookEventName: 'PreToolUse', permissionDecision: decision, permissionDecisionReason: reason }
  process.stdout.write(JSON.stringify({ hookSpecificOutput: output }))
}

if (!permissionManifestFound) {
  respond('deny', `roborepo permissions: manifest not found at ${manifestPath}, so this command cannot be checked.`)
  process.exit(0)
}

// Simple whitespace tokenization — matches how the manifest's own command patterns are authored
// (space-separated argv-style arrays). A command with a pipe or `&&` is deliberately NOT split
// further here: it's tokenized as one flat word list, so a rule like ["git","push"] still matches
// `git push origin main` but won't falsely match `echo hi && git push` (the leading tokens are
// `echo hi && git push...`, not `git push...`) — consistent with "we only tighten what we can
// confidently classify," matching the same conservative stance minimize-bash-output.mjs documents.
const commandTokens = command.trim().split(/\s+/)

const matches = allCommandRules().filter((r) => matchesPrefix(commandTokens, r.tokens))
// Native rules use the most restrictive matching decision, not the longest prefix.
const rule = matches.find((r) => r.bucket === 'deny')
  || matches.find((r) => r.bucket === 'ask') || matches[0]
if (!rule) process.exit(0)
if (rule.bucket === 'allow' && /[;&|<>`\n]|\$\(/.test(command)) process.exit(0)

const genericPush = (r) => r.behaviorId === 'push-code'
  && r.tokens.length === 2 && r.tokens[0] === 'git' && r.tokens[1] === 'push'
if (rule.bucket === 'ask' && genericPush(rule)) {
  // Do not let the generic push exception swallow an explicit personal ask for the same or a matching prefix.
  const otherAsk = matches.some((r) => r.bucket === 'ask' && !genericPush(r))
  const output = verifiedPushDecision(input)
  // Quoting, expansion, or chaining can hide a personal rule from whitespace matching.
  // Only literal argv words may receive this exception; native rules handle the rest.
  const singleCommand = /^[A-Za-z0-9_./:@%+=-]+(?:[ \t]+[A-Za-z0-9_./:@%+=-]+)*$/.test(command.trim())
  if (output?.permissionDecision === 'deny' || (output && !otherAsk && singleCommand)) {
    respond(output.permissionDecision, output.permissionDecisionReason)
    process.exit(0)
  }
  if (!output) {
    respond('deny', 'roborepo permissions: the push guard could not verify this command.')
    process.exit(0)
  }
}

// Defer confirmations to native prompt rules. An allow here cannot grant a pending escalation.
if (rule.bucket === 'ask' || (approvalRequest && rule.bucket === 'allow')) process.exit(0)
respond(rule.bucket, `roborepo permissions: "${rule.tokens.join(' ')}" is ${rule.bucket}`)
