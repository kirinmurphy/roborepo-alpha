import { mergeHooksMap } from "../hooks-merge.mjs";

// Labels appear in native review and belong to the approved definition. Reconcile only this
// metadata in place: moving handlers would also invalidate unrelated hooks' positional trust.
export function mergeCodexHooks(hooks, fragment) {
  const merged = mergeHooksMap(hooks, fragment, { append: true });
  let changed = merged.added > 0;
  const next = { ...merged.hooks };
  for (const [event, entries] of Object.entries(fragment)) {
    if (event.startsWith("_") || !Array.isArray(entries)) continue;
    const labels = new Map(entries.flatMap((entry) => entry.hooks || [])
      .filter((hook) => hook.command && typeof hook.statusMessage === "string")
      .map((hook) => [hook.command, hook.statusMessage]));
    if (!labels.size) continue;
    next[event] = next[event].map((entry) => ({
      ...entry,
      hooks: (entry.hooks || []).map((hook) => {
        if (!labels.has(hook.command) || hook.statusMessage === labels.get(hook.command)) return hook;
        changed = true;
        return { ...hook, statusMessage: labels.get(hook.command) };
      }),
    }));
  }
  return { hooks: next, changed };
}
