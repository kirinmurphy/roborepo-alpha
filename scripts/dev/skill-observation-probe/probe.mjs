// Manual probe: the shipped skill-reference observer, plus a unique token and a fire log.
//
// This exists to test the one thing no automated check can: whether injected additionalContext is
// still in a live agent's context at the end of a long turn.
//
// Kept deliberately close to globals/packages/skill-visibility/hooks/skill-reference-observer.mjs.
// It is not that file, because the probe adds a token and a log the shipped hook must never carry —
// but if the two drift in how they match paths, this probe stops testing the real thing.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const PROBE_TOKEN = 'PROBETOKEN-Q7X4'
const here = path.dirname(fileURLToPath(import.meta.url))

const noop = () => process.exit(0)

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  noop()
}

const filePath = (input.tool_input || {}).file_path || ''
if (!filePath) noop()

// Literal match, no realpath — the same rule the shipped hook follows, and the reason this probe
// is a copy rather than an import: it must fail the same way the real hook would.
const abs = path.resolve(filePath)
const home = os.homedir()
const roots = [path.join(home, '.claude', 'skills'), path.join(home, '.codex', 'skills')]
const root = roots.find(candidate => abs.startsWith(candidate + path.sep))
if (!root) noop()
if (!abs.includes(`${path.sep}references${path.sep}`)) noop()

const rel = path.relative(root, abs)
const skill = rel.split(path.sep)[0]
const reference = rel.split(path.sep).slice(1).join('/')
if (!skill || !reference) noop()

// Independent evidence that the hook fired, so step 2 of the procedure does not depend on the
// agent's own account of what it saw.
try {
  fs.appendFileSync(path.join(here, 'fired.log'), `${new Date().toISOString()} ${skill}/${reference}\n`)
} catch {
  // A missing log is not a reason to skip the injection being tested.
}

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PostToolUse',
      additionalContext: `[skill-visibility] observed reference read: ${skill}/${reference} ${PROBE_TOKEN}`,
    },
  }),
)
