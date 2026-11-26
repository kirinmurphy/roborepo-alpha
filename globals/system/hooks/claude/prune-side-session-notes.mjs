import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// SessionStart: prune the Claude desktop app's side-session notes folder by its retention policy.
//
// The app tells side sessions to leave hand-over notes for each other under
// ~/Library/Application Support/Claude/side-session-notes/<session-id>/ and never removes them.
// That folder is one of the manifest's temporaryLocations, which agents read and write without a
// prompt, and every temporary location needs a cleanup. Session start is the folder's nearest
// write path: a new side session is about to use it. A folder changed in the last 14 days, the
// newest folder, and anything a link would reach outside the store are always kept; the policy
// lives in modules/retention/registry.mjs.
//
// It never blocks or slows a session in a way that matters: every failure is silent, and an
// absent folder (Linux, or no side sessions yet) is a no-op. Removals are reported on stderr only.
//
// This file runs as a copy under the harness home, so the retention module is found through the
// app root the CLI records at install, as the repository-boundary hook finds the manifest.

const quiet = () => process.exit(0)

function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return null
  }
}

const stateDir = process.env.ROBOREPO_STATE_ROOT || path.join(os.homedir(), '.roborepo')

function appRoots() {
  return [
    process.env.REPO_ROOT,
    readJson(path.join(stateDir, 'app-root.json'))?.appRoot,
    readJson(path.join(stateDir, 'install-state.json'))?.repo,
    path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'),
  ].filter((root) => typeof root === 'string' && root)
}

try {
  const root = appRoots().find((candidate) => fs.existsSync(path.join(candidate, 'modules', 'retention', 'index.mjs')))
  if (!root) quiet()
  const retention = await import(pathToFileURL(path.join(root, 'modules', 'retention', 'index.mjs')).href)
  const store = retention.findRetentionStore(stateDir, retention.SIDE_SESSION_NOTES_STORE_ID)
  if (!store) quiet()
  const { removed } = retention.pruneFolderSet({ dirPath: store.target, policy: store.policy })
  if (removed.length) {
    process.stderr.write(`roborepo: removed ${removed.length} side-session notes folder(s) unchanged for ${store.policy.maxAgeDays} days\n`)
  }
} catch {
  // Pruning is housekeeping; a failure here must never surface as a session-start error.
}
quiet()
