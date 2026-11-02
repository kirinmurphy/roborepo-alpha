// Pure hooks-map merge/unmerge logic, extracted from scripts/cli/hook-composition.mjs so provider
// adapters (scripts/harnesses/{claude,codex}/index.mjs) can call it without importing paths.mjs's
// registry-dependent half — hook-composition.mjs pulls in harnessHome, provider paths, and
// writeRootConfig, which resolve through scripts/harnesses/registry.mjs, so a provider
// adapter importing hook-composition.mjs directly would cycle back into itself (same class of
// import cycle as paths.mjs/roots.mjs).
//
// These functions operate on already-parsed hooks maps and content strings only — no file I/O, no
// path resolution. hook-composition.mjs (the orchestrator-facing module, which does import
// paths.mjs directly with no cycle risk since it sits above the registry in the dependency graph)
// wraps these with the harness-specific read/write file mechanics.

// A plain object (not null, not an array) — some fixtures/older files use `[]` as an "empty hooks"
// sentinel, which must not be treated as a map: string-keyed writes onto an array silently vanish
// from JSON.stringify (arrays only serialize numeric indices).
export function isHooksMap(value) {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

// Prepends by default: a package's own hooks may need to run before pre-existing entries for the
// same event/matcher (e.g. a deny-decision hook must execute before an allow-decision one — Claude's
// hook model treats the first decisive result as final). `append: true` is for Codex, which keys
// hook trust by position (`<file>:<event>:<group index>:<handler index>`), so moving an existing
// entry would revoke trust the user already granted. Either way the fragment's own internal entry
// order is preserved.
//
// A hook's identity is its handler command, not its group: a fragment group that gains a handler
// keeps its already-installed handlers where they are and adds only the new ones, as a group of
// their own. Matching on a group's first command instead re-adds the whole group, duplicating every
// handler already installed.
//
// Older installs did exactly that, so merging also removes later copies of the fragment's own
// handlers, keeping the first. Only RoboRepo's commands are collapsed; a user's repeated handler is
// theirs. On Codex, removing a copy shifts the handlers after it in its group, which then need
// review again, the same as any other hook change.
export function mergeHooksMap(hooksMap, hooksFragment, { append = false } = {}) {
  const hooks = { ...hooksMap };
  let added = 0;
  let duplicatesRemoved = 0;
  for (const [event, entries] of Object.entries(hooksFragment)) {
    if (event.startsWith("_") || !Array.isArray(entries)) continue;
    const owned = new Set(entries.flatMap((entry) => (entry.hooks || []).map((hook) => hook.command)).filter(Boolean));
    const collapsed = withoutRepeatedHandlers(hooks[event] || [], owned);
    duplicatesRemoved += collapsed.removed;
    const existing = collapsed.entries;
    const seen = new Set(existing.flatMap((entry) => (entry.hooks || []).map((hook) => hook.command)).filter(Boolean));
    const fresh = [];
    for (const entry of [...entries].reverse()) {
      const handlers = entry.hooks || [];
      const kept = handlers.filter((hook) => !hook.command || !seen.has(hook.command));
      const newCommands = kept.filter((hook) => hook.command);
      if (newCommands.length === 0 && handlers.some((hook) => hook.command)) continue;
      fresh.unshift(kept.length === handlers.length ? entry : { ...entry, hooks: kept });
      for (const hook of newCommands) seen.add(hook.command);
      added += Math.max(newCommands.length, 1);
    }
    hooks[event] = append ? [...existing, ...fresh] : [...fresh, ...existing];
  }
  return { hooks, added, duplicatesRemoved };
}

function withoutRepeatedHandlers(entries, commands) {
  const seen = new Set();
  let removed = 0;
  const kept = [];
  for (const entry of entries) {
    const handlers = entry.hooks || [];
    const unique = handlers.filter((hook) => {
      if (!commands.has(hook.command)) return true;
      if (seen.has(hook.command)) return false;
      seen.add(hook.command);
      return true;
    });
    removed += handlers.length - unique.length;
    if (unique.length === handlers.length) kept.push(entry);
    else if (unique.length) kept.push({ ...entry, hooks: unique });
  }
  return { entries: kept, removed };
}

// Removes the fragment's handlers by command, from whichever group holds them, and drops a group
// only once it has no handlers left, so a user's own handler sharing a group with ours survives.
export function unmergeHooksMap(hooksMap, hooksFragment) {
  const hooks = { ...hooksMap };
  let removed = 0;
  for (const [event, entries] of Object.entries(hooksFragment)) {
    if (event.startsWith("_") || !Array.isArray(entries)) continue;
    const cmds = new Set(entries.flatMap((e) => (e.hooks || []).map((hook) => hook.command)).filter(Boolean));
    const next = [];
    for (const entry of hooks[event] || []) {
      const handlers = entry.hooks || [];
      const kept = handlers.filter((hook) => !hook.command || !cmds.has(hook.command));
      removed += handlers.length - kept.length;
      if (kept.length === handlers.length) next.push(entry);
      else if (kept.length) next.push({ ...entry, hooks: kept });
    }
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  return { hooks, removed };
}
