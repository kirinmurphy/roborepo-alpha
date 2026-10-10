// Pure hooks-map merge/unmerge logic, extracted from scripts/cli/hook-composition.mjs so provider
// adapters (scripts/harnesses/{claude,codex}/index.mjs) can call it without importing paths.mjs's
// registry-dependent half — hook-composition.mjs pulls in codexHooksPath/harnessHome and
// writeRootConfig, both of which resolve through scripts/harnesses/registry.mjs, so a provider
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

export function mergeHooksMap(hooksMap, hooksFragment) {
  const hooks = { ...hooksMap };
  let added = 0;
  for (const [event, entries] of Object.entries(hooksFragment)) {
    if (event.startsWith("_") || !Array.isArray(entries)) continue;
    const existing = [...(hooks[event] || [])];
    // Prepend (not append): a package's own hooks may need to run before pre-existing entries for
    // the same event/matcher (e.g. a deny-decision hook must execute before an allow-decision one —
    // Claude's hook model treats the first decisive result as final). Preserve the fragment's own
    // internal entry order by prepending in reverse.
    for (const entry of [...entries].reverse()) {
      const cmd = entry.hooks?.[0]?.command;
      const alreadyPresent = cmd && existing.some((e) => (e.hooks || []).some((h) => h.command === cmd));
      if (!alreadyPresent) { existing.unshift(entry); added++; }
    }
    hooks[event] = existing;
  }
  return { hooks, added };
}

export function unmergeHooksMap(hooksMap, hooksFragment) {
  const hooks = { ...hooksMap };
  let removed = 0;
  for (const [event, entries] of Object.entries(hooksFragment)) {
    if (event.startsWith("_") || !Array.isArray(entries)) continue;
    const cmds = new Set(entries.map((e) => e.hooks?.[0]?.command).filter(Boolean));
    const existing = hooks[event] || [];
    const next = existing.filter((e) => {
      const cmd = e.hooks?.[0]?.command;
      if (cmd && cmds.has(cmd)) { removed++; return false; }
      return true;
    });
    if (next.length) hooks[event] = next;
    else delete hooks[event];
  }
  return { hooks, removed };
}
