import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

// Fires on Write/Edit for managed harness home dirs (~/.claude or ~/.codex).
// Most managed assets are symlinked into the repo. Mutable root config files are
// active local files instead, so remind agents to merge portable changes
// intentionally instead of assuming every HOME write is repo-backed.
// Visible from any repo because this hook is installed globally under ~/.claude.

const input = JSON.parse(fs.readFileSync(0, 'utf8'))
const toolInput = input.tool_input || {}
const filePath = toolInput.file_path || ''

const noop = () => process.exit(0)

if (!filePath) noop()

const abs = path.resolve(filePath)
const home = os.homedir()
const guarded = [path.join(home, '.claude'), path.join(home, '.codex')]

const underGuarded = guarded.some(
  dir => abs === dir || abs.startsWith(dir + path.sep),
)
if (!underGuarded) noop()

// settings.local.json is intentionally machine-local, not in the repo.
if (path.basename(abs) === 'settings.local.json') noop()

const isNewFile = !fs.existsSync(abs)
const rootConfigPaths = new Set([
  path.join(home, '.claude', 'settings.json'),
  path.join(home, '.codex', 'config.toml'),
])

const reminder = rootConfigPaths.has(abs)
  ? `This is mutable active root config, not a repo symlink. Keep user/project trust, hook approvals, profiles, and machine-local state here; merge only intentional portable defaults into the repo baseline.`
  : isNewFile
    ? `This path symlinks into the version-controlled roborepo. Do NOT create a new file directly here. Create it in the repo (for a skill: use roborepo package dev create or package dev add-skill, then run roborepo skill sync-global). See the roborepo-support skill.`
    : `This file is a symlink into the version-controlled source repo. Editing here is fine — it resolves to the root file — but commit the change in that repo, not from the current working dir.`

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      additionalContext: `[roborepo-support] ${reminder}`,
    },
  }),
)
