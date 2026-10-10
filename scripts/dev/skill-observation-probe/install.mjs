// Installs the survival probe into ~/.claude/settings.json, backing up the current file first.
// Undo with restore.mjs.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const settingsPath = path.join(os.homedir(), '.claude', 'settings.json')
const backupPath = path.join(here, 'settings.json.bak')
const probePath = path.join(here, 'probe.mjs')

if (!fs.existsSync(settingsPath)) {
  console.error(`no settings file at ${settingsPath}`)
  process.exit(1)
}

// Refuse to overwrite an existing backup: that means a probe is already installed, and clobbering
// the backup would strand the original settings with no way back.
if (fs.existsSync(backupPath)) {
  console.error(`backup already exists at ${backupPath} — run restore.mjs before installing again`)
  process.exit(1)
}

fs.copyFileSync(settingsPath, backupPath)

const settings = JSON.parse(fs.readFileSync(settingsPath, 'utf8'))
settings.hooks = settings.hooks || {}
settings.hooks.PostToolUse = (settings.hooks.PostToolUse || []).filter(
  entry => !JSON.stringify(entry).includes('skill-observation-probe'),
)
settings.hooks.PostToolUse.push({
  matcher: 'Read',
  hooks: [{ type: 'command', command: `node "${probePath}"` }],
})
fs.writeFileSync(settingsPath, JSON.stringify(settings, null, 2))

console.log(`probe installed; backup at ${backupPath}`)
console.log('start a new session, read a skill reference, then run 10+ unrelated tool calls')
