import fs from 'node:fs'
import path from 'node:path'

// --- Block Bash source-file exploration, redirect to jcodemunch ----------------------------
//
// PURPOSE: the Grep/Glob TOOLS are hard-blocked elsewhere, but the agent route-arounds by
// shelling out — `Bash(grep src/...)`, `cat file.ts`, `find . -name '*.ts'`. That defeats the
// jcodemunch-first rule. This hook closes that door for SOURCE files only.
//
// PACKAGE-OWNED: this hook is installed/removed only when the jcodemunch package is enabled/disabled
// (globals/packages-archived/jcodemunch/package.config.json's hooks/claude component), so it is never present
// on a machine where jcodemunch isn't actually available. No runtime self-check is needed — a prior
// version gated on `mcpServers.jcodemunch` in ~/.claude/settings.json (the wrong native store; the
// real live MCP registration lives in ~/.claude.json) as a belt-and-suspenders guard against stale
// unconditional baseline wiring. That guard is redundant now that enable/disable itself controls
// whether this file is wired at all, so it was removed rather than fixed.
//
// DESIGN — "allow when unsure" (deliberate): Bash legitimately does things jcodemunch cannot
// (grep a log, cat a json/lockfile, pipe `git log | grep`, inspect /tmp). We must never block
// those. So we DENY only when ALL of these hold, and ALLOW everything else:
//
//   verb is grep/rg/ag/cat/head/tail/find
//   AND there is an explicit file-path argument (not piped, not stdin)
//   AND that path is inside the repo (relative, or under cwd)
//   AND the path has a SOURCE extension
//   AND the path is not under node_modules/dist/build/.next/coverage/vendor
//
// Any pipe in the command => allow (it is processing command output, not reading a source file).
// Anything ambiguous => allow. A determined agent can still leak (e.g. grep with no path arg);
// that is the accepted cost of never breaking legitimate Bash work.
//
// head/tail EXCEPTION: a bounded peek (`head -50 file.ts`, `tail -n 20 file.ts`) is cheap and
// normal — allowed regardless of extension/location. Unbounded head/tail and all cat/grep/rg/ag/find
// still follow the rules above.
//
// ORDER: this hook must run FIRST in the PreToolUse:Bash chain, before minimize-bash-output.mjs
// (which auto-allows bare `grep`). First decisive decision wins in Claude's hook model, so a
// deny here is final; anything we allow falls through to the rest of the chain unchanged.

const fail = () => process.exit(0) // any error => silent passthrough, never block by accident

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  fail()
}

const toolInput = input.tool_input || {}
const command = typeof toolInput.command === 'string' ? toolInput.command : ''
const cwd = input.cwd || process.cwd()
if (!command) process.exit(0)

const trimmed = command.trim()

// Any pipe => processing output, not reading a source file. Allow.
if (trimmed.includes('|')) process.exit(0)

const SOURCE_EXT = new Set([
  '.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs',
  '.py', '.go', '.rs', '.java', '.rb', '.php',
  '.c', '.h', '.cpp', '.cc', '.hpp', '.cs',
  '.swift', '.kt', '.scala', '.vue', '.svelte',
])

const EXCLUDED_DIR = /(^|\/)(node_modules|dist|build|\.next|coverage|vendor|out)(\/|$)/

// verb must be a read/search command, first token.
const verb = trimmed.split(/\s+/)[0]
if (!/^(grep|rg|ag|cat|head|tail|find)$/.test(verb)) process.exit(0)

const rawArgs = trimmed.split(/\s+/).slice(1)

// head/tail with an explicit bound (-n 50, -50, -c 200) is a cheap, normal one-line peek — the
// audit's complaint. Only bare/unbounded head|tail (which defaults to reading the whole default
// window, usually fine, but indistinguishable from "read the whole file" intent) stays blocked.
// cat is never allowed through this path — it has no bound to check.
if (verb === 'head' || verb === 'tail') {
  const hasBound = rawArgs.some(t => /^-(n|c)$/.test(t) || /^-\d+$/.test(t) || /^--(lines|bytes)(=.*)?$/.test(t))
  if (hasBound) process.exit(0)
}

// Tokenize args, drop any flags (leading '-'). Whatever remains and looks like a
// path is a candidate target. find's pattern lives in -name, so for find we test the search root.
const tokens = rawArgs.filter(t => t && !t.startsWith('-'))

// strip simple surrounding quotes
const unquote = t => t.replace(/^['"]|['"]$/g, '')

const isInsideRepo = p => {
  if (path.isAbsolute(p)) {
    const rel = path.relative(cwd, p)
    return rel !== '' && !rel.startsWith('..')
  }
  // relative path: inside unless it climbs out
  const rel = path.normalize(p)
  return !rel.startsWith('..')
}

// A target is "source exploration" when it is an inside-repo path with a source extension and
// not in an excluded dir. For grep/rg/ag the path is typically the LAST arg (pattern first);
// for cat/head/tail any arg may be a file. We flag if ANY candidate token qualifies.
const flagged = tokens.some(raw => {
  const t = unquote(raw)
  if (!t || t === '.') return false
  if (EXCLUDED_DIR.test(t)) return false
  const ext = path.extname(t)
  if (!SOURCE_EXT.has(ext)) return false
  return isInsideRepo(t)
})

if (!flagged) process.exit(0)

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: 'deny',
      permissionDecisionReason:
        'Source-file exploration via Bash is blocked. Use jcodemunch instead: search_text (content), search_symbols (definitions), get_file_outline (structure), find_references (callers), get_context_bundle (targeted context). This block fires ONLY for source files inside the repo — grep/cat on logs, json, config, /tmp, or piped output is allowed.',
    },
  }),
)
