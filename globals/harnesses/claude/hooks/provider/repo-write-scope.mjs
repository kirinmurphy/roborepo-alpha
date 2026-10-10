import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

// Claude's implementation of the platform's `repo-scope` behavior. Fires on Read/Write/Edit.
//
// The zone differs by operation, deliberately:
//
//   WRITES  are bounded to the checkout in use. A worktree is its own boundary; writing from a
//           worktree into its primary checkout prompts. That is how one session clobbers another's
//           in-flight work, and it is rare — isolation is the reason to branch in the first place.
//   READS   span the whole repository family: a worktree, its primary checkout, and its siblings.
//           Reading main to compare against a branch is routine and harmless, and prompting for it
//           would train approval reflex on an operation that never needed review.
//
// Anything outside gets the bucket the manifest assigns to `repo-write-boundary`.
//
// Reads are NOT unrestricted outside the family. An enumerated denylist (`read-secrets`) covers
// known credential material, but it cannot cover what it does not name — a tax document, a client
// repository under NDA. The perimeter is what handles unknown-sensitive files, which is why the
// denylist does not replace it.
//
// OWNERSHIP: the platform states the intent (manifests/inventory/agent-permissions.json declares
// the behavior, its label, and its bucket); this file is how Claude specifically enforces it. Codex
// expresses the same intent through its workspace sandbox instead, which is why this lives under
// the provider rather than in a shared hooks directory.
//
// WHY A HOOK: the boundary is "the repository you are in", and a Claude permission rule cannot
// express that. Rule paths are literal strings with no variable expansion, and no anchor resolves
// to the current repository — `/path` in a user-level settings file resolves relative to that
// settings file's own directory, not to any checkout. So the boundary has to be decided at
// tool-call time.
//
// The static rules remain the coarse layer: they allow the scratch directories that are correct
// regardless of which repository is in use. This hook narrows the repository half of that scope
// from "some fixed tree" to "the checkout the agent is actually in".
//
// COST: the repository root is found by walking up from cwd looking for `.git`, in-process. That
// is ~0.09ms per call, against ~155ms to spawn `git rev-parse --show-toplevel`. This runs on every
// Write and Edit, so the spawn is not affordable and the walk is.
//
// A worktree resolves to itself, not to its primary checkout: `.git` is a FILE there rather than a
// directory, and existsSync matches either. That is the intended behavior — work in a worktree
// should not silently write into the main checkout.
//
// DESIGN — "ask when unsure": every failure path exits silently and lets the existing permission
// rules decide. A hook that cannot determine the answer must not manufacture one, in either
// direction: returning `allow` on a bad parse would widen the scope this exists to narrow, and
// returning `deny` would break writes on any path the hook did not anticipate.

const noop = () => process.exit(0) // any error or unknown => defer to the static rules

let input
try {
  input = JSON.parse(fs.readFileSync(0, 'utf8'))
} catch {
  noop()
}

// The outside-the-repo decision is the platform's to set, not this hook's to assume: it is the
// bucket on the `repo-write-boundary` behavior, layered with any personal override the same way
// every other permission is. Reading it here is what keeps the platform the instructor and this
// file merely the Claude-side enforcement.
//
// Resolution mirrors the Codex permission hook: an explicit env var, then recorded install state,
// then this file's own location walked back to the repository root.
function readJson(p, fallback) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch {
    return fallback
  }
}

function outsideRepoBucket() {
  const stateDir = process.env.ROBOREPO_STATE_DIR || path.join(os.homedir(), '.roborepo')
  const candidates = []
  if (process.env.REPO_ROOT) candidates.push(process.env.REPO_ROOT)
  const state = readJson(path.join(stateDir, 'install-state.json'), {})
  if (typeof state.repo === 'string' && state.repo) candidates.push(state.repo)
  candidates.push(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..'))

  for (const root of candidates) {
    const manifest = readJson(path.join(root, 'manifests', 'inventory', 'agent-permissions.json'), null)
    const behavior = manifest?.behaviors?.find(b => b.id === 'repo-write-boundary')
    if (!behavior) continue
    const overrides = readJson(path.join(stateDir, 'command-overrides.json'), {})
    return overrides?.behaviors?.['repo-write-boundary'] || behavior.bucket
  }
  // Manifest unreadable: the platform has not stated an intent this hook can act on, so it does
  // not invent one — the static rules decide, exactly as if this hook were not installed.
  return null
}

const toolInput = input.tool_input || {}
const filePath = toolInput.file_path || ''
if (!filePath) noop()

// Locations that are correct to write regardless of which repository is in use: agent scratch
// space, and the managed harness homes (write-guard.mjs already annotates those writes;
// prompting for them as well would be noise on top of a reminder).
const home = os.homedir()
const alwaysAllowed = [
  os.tmpdir(),
  '/tmp',
  '/private/tmp',
  '/private/var/folders',
  path.join(home, '.claude'),
  path.join(home, '.codex'),
  path.join(home, '.roborepo'),
]

const contains = (dir, target) => target === dir || target.startsWith(dir + path.sep)

// Containment is a string comparison, so both sides have to describe a path the same way. They do
// not by default: on macOS `os.tmpdir()` yields `/var/folders/...` while git records the resolved
// `/private/var/folders/...` in its worktree pointer files, and `/var` is a symlink to `/private/var`.
// The same mismatch appears wherever a checkout sits under a symlinked parent.
//
// Resolving both sides removes the discrepancy. A path that cannot be resolved (it does not exist
// yet — the common case for a Write creating a new file) falls back to the lexical form, which is
// what the walk already produced.
function realpath(p) {
  // Walk up to the nearest ancestor that exists, resolve that, then re-append the segments that do
  // not exist yet. A Write commonly targets a file — and sometimes whole directories — that are not
  // on disk, so resolving only the immediate parent is not enough.
  let dir = p
  const trailing = []
  for (;;) {
    try {
      return path.join(fs.realpathSync(dir), ...trailing)
    } catch {
      const up = path.dirname(dir)
      if (up === dir) return p // reached the filesystem root without resolving anything
      trailing.unshift(path.basename(dir))
      dir = up
    }
  }
}

function repositoryRoot(start) {
  let dir
  try {
    dir = path.resolve(start)
  } catch {
    return null
  }
  for (;;) {
    // `.git` is a directory in a normal checkout and a file in a linked worktree; either marks a
    // root, so no stat-type check is wanted here. The root is resolved before being returned so it
    // compares correctly against a resolved target — see realpath() above.
    if (fs.existsSync(path.join(dir, '.git'))) return realpath(dir)
    const up = path.dirname(dir)
    if (up === dir) return null
    dir = up
  }
}

// The primary checkout behind a root, or null when the root IS the primary checkout.
//
// In a linked worktree `.git` is a FILE reading `gitdir: <path>/.git/worktrees/<name>`. The
// `commondir` file beside that gitdir points back at the primary `.git` (normally `../..`), whose
// parent is the primary checkout. Both are plain file reads — no `git` spawn, keeping this on the
// same cheap footing as the root walk above.
//
// Returns null on anything unexpected. A read that cannot resolve a family simply falls back to the
// worktree-only boundary, which is the safe direction: it prompts more, never less.
function primaryCheckout(root) {
  let pointer
  try {
    const dotGit = path.join(root, '.git')
    if (!fs.statSync(dotGit).isFile()) return null // a normal checkout is already primary
    pointer = fs.readFileSync(dotGit, 'utf8').trim()
  } catch {
    return null
  }

  const match = /^gitdir:\s*(.+)$/.exec(pointer)
  if (!match) return null
  const gitDir = path.resolve(root, match[1].trim())

  try {
    const commonRaw = fs.readFileSync(path.join(gitDir, 'commondir'), 'utf8').trim()
    if (!commonRaw) return null
    // commondir is normally relative to the worktree's gitdir; tolerate an absolute value too.
    const commonDir = path.resolve(gitDir, commonRaw)
    const primary = realpath(path.dirname(commonDir))
    return primary && primary !== root ? primary : null
  } catch {
    return null
  }
}

// Every checkout that counts as "the same project" for a READ: the current root, its primary
// checkout, and every sibling worktree registered under that primary.
function repositoryFamily(root) {
  const family = [root]
  // From a linked worktree, the primary is behind the `.git` pointer. From the primary itself
  // there is no pointer to follow — it IS the primary, and its own worktrees are enumerated below.
  const primary = primaryCheckout(root) ?? root
  if (primary !== root) family.push(primary)

  // Worktrees are listed under the primary's .git/worktrees/<name>/gitdir, each naming that
  // worktree's own `.git` file. This is what makes the relation symmetric: a worktree reaches its
  // primary through the pointer, and the primary reaches every worktree through this directory.
  // Missing or unreadable entries are skipped rather than fatal.
  try {
    const worktreesDir = path.join(primary, '.git', 'worktrees')
    for (const name of fs.readdirSync(worktreesDir)) {
      try {
        const gitdirFile = fs.readFileSync(path.join(worktreesDir, name, 'gitdir'), 'utf8').trim()
        if (!gitdirFile) continue
        const sibling = realpath(path.dirname(path.resolve(gitdirFile)))
        if (sibling && !family.includes(sibling)) family.push(sibling)
      } catch {
        continue
      }
    }
  } catch {
    // No worktrees directory, or unreadable: the family is just root plus primary.
  }
  return family
}

const target = realpath(path.resolve(filePath))

// cwd is the session's working directory, which may be a subdirectory of the checkout.
const root = repositoryRoot(input.cwd || process.cwd())

// The repository check comes FIRST, before the scratch allowlist. A checkout can live under a
// scratch path — cloning into /tmp to test something is normal — and when it does, the repository
// boundary is still the boundary that matters. Testing scratch first would hand back "allowed" for
// every path in that clone, including writes into a sibling clone beside it.
// Reads see the whole repository family; writes see only the checkout in use. `tool_name` is absent
// on malformed input, in which case the narrower write zone applies — the safe default.
const isRead = input.tool_name === 'Read'
const zone = root ? (isRead ? repositoryFamily(root) : [root]) : []

const inZone = zone.find(dir => contains(dir, target))
if (inZone) {
  process.stdout.write(
    JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'PreToolUse',
        permissionDecision: 'allow',
        permissionDecisionReason:
          inZone === root
            ? 'Inside the current repository.'
            : `Inside the same repository family (${inZone}).`,
      },
    }),
  )
  process.exit(0)
}

// Outside the current repository. Scratch space is exempt — those paths are correct to write
// whichever repository is in use, and the static rules already allow them, so prompting on top of
// an existing allow would be noise.
//
// "In scratch" means a loose file there, though, not another checkout that happens to live under
// it. A clone inside /tmp is still a repository, and writing into it from a different repository
// is exactly the cross-repository write this hook exists to catch — so a target with its own
// repository root is never treated as scratch.
if (alwaysAllowed.some(dir => contains(dir, target)) && !repositoryRoot(path.dirname(target))) noop()

// Not in a repository at all — there is no boundary to be outside of, so leave the decision to
// the static rules rather than inventing one.
if (!root) noop()

const bucket = outsideRepoBucket()
// "allow" means the platform has switched the boundary off; say nothing and let the static rules
// apply, rather than emitting an allow that would out-rank them.
if (!bucket || bucket === 'allow') noop()

process.stdout.write(
  JSON.stringify({
    hookSpecificOutput: {
      hookEventName: 'PreToolUse',
      permissionDecision: bucket,
      permissionDecisionReason: isRead
        ? `This path is outside the repository family you are working in (${root}). Reading here reaches files that are not part of this project.`
        : `This path is outside the repository you are working in (${root}). Writing here affects files that are not part of this checkout.`,
    },
  }),
)