// The Backlog's view model: which directory level the URL names, what each level counts, and the
// edits an Ordering draft allows. Pure, with no DOM and no requests, so the rules run in Node checks.
// The order itself comes from the server (snapshot.backlog); nothing here recomputes dependencies.
// A draft holds the server's blocks and only ever moves whole blocks, which is what keeps linked
// plans contiguous and prerequisites ahead of their dependents.

export const NAMESPACE_PARAM = "namespace";
// `_` cannot appear in a plan filename's namespace, so this never collides with a real one.
export const NO_NAMESPACE = "_none";

export function namespaceFromSearch(search) {
  return new URLSearchParams(search).get(NAMESPACE_PARAM) || null;
}

export function hrefWithNamespace(href, namespace) {
  const url = new URL(href, "http://portal.invalid");
  if (namespace) url.searchParams.set(NAMESPACE_PARAM, namespace);
  else url.searchParams.delete(NAMESPACE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// The Backlog's title label: the derived namespace first, never written into the H1.
export function displayTitle(plan) {
  return plan.namespace ? `${plan.namespace.toUpperCase()} · ${plan.title}` : plan.title;
}

function pendingKeys(view) {
  return [...view.needsPrioritization.flatMap((block) => block.keys), ...view.unrankable];
}

// Repositories with Backlog plans among `matchingKeys`, the plans the Filters popup leaves.
export function repositoryDirectory(backlog, matchingKeys) {
  return backlog
    .map((entry) => {
      const pending = new Set(entry.namespaces.flatMap(pendingKeys));
      const keys = [...entry.namespaces.flatMap(keysOfView), ...entry.noNamespace].filter((key) => matchingKeys.has(key));
      return {
        repositoryId: entry.repositoryId,
        name: entry.name,
        urlKey: entry.urlKey,
        planCount: keys.length,
        unprioritizedCount: keys.filter((key) => pending.has(key)).length,
      };
    })
    .filter((row) => row.planCount > 0)
    .sort((a, b) => a.name.localeCompare(b.name));
}

function keysOfView(view) {
  return [...view.ordered.flatMap((block) => block.keys), ...pendingKeys(view)];
}

// Approved namespaces with matching plans, then No namespace last when any plan lands there.
export function namespaceDirectory(entry, matchingKeys) {
  const rows = entry.namespaces.map((view) => {
    const pending = new Set(pendingKeys(view));
    const keys = keysOfView(view).filter((key) => matchingKeys.has(key));
    return { namespace: view.namespace, planCount: keys.length, unprioritizedCount: keys.filter((key) => pending.has(key)).length };
  }).filter((row) => row.planCount > 0);
  const repair = entry.noNamespace.filter((key) => matchingKeys.has(key));
  if (repair.length) rows.push({ namespace: NO_NAMESPACE, planCount: repair.length, unprioritizedCount: 0 });
  return rows;
}

export function createDraft(view) {
  return {
    namespace: view.namespace,
    revision: view.revision,
    ordered: view.ordered,
    needs: view.needsPrioritization,
    committedIds: orderedIds({ ordered: view.ordered }),
    stale: false,
  };
}

export function orderedIds(draft) {
  return draft.ordered.flatMap((block) => block.ids);
}

// The draft has something to save: a changed order, or a plan placed out of Needs prioritization.
export function isDraftDirty(draft) {
  return Boolean(draft) && orderedIds(draft).join("\0") !== draft.committedIds.join("\0");
}

// The actions each section's block offers, in the order their controls appear. "place-top" is the
// Needs prioritization control labelled Move down: it moves the block down into Ordered, at its top.
export const ORDERED_ACTIONS = ["top", "up", "down", "bottom"];
export const NEEDS_ACTIONS = ["place-top", "bottom"];

export function isActionEnabled(section, action, index, count) {
  if (section === "needs") return true;
  if (action === "top" || action === "up") return index > 0;
  return index < count - 1;
}

export function moveBlock(draft, section, index, action) {
  if (section === "needs") {
    const block = draft.needs[index];
    const needs = draft.needs.filter((_, position) => position !== index);
    return { ...draft, needs, ordered: action === "place-top" ? [block, ...draft.ordered] : [...draft.ordered, block] };
  }
  const targets = { top: 0, up: index - 1, down: index + 1, bottom: draft.ordered.length - 1 };
  return { ...draft, ordered: withBlockAt(draft.ordered, index, targets[action]) };
}

function withBlockAt(blocks, from, to) {
  const next = blocks.filter((_, position) => position !== from);
  next.splice(to, 0, blocks[from]);
  return next;
}

// A drop inserts before the block now at `before`, counted in the Ordered list as drawn while the
// dragged block is still in it. A block dropped where it already sits leaves the draft unchanged.
export function dropBlock(draft, section, index, before) {
  if (section === "needs") {
    const block = draft.needs[index];
    const ordered = [...draft.ordered];
    ordered.splice(before, 0, block);
    return { ...draft, needs: draft.needs.filter((_, position) => position !== index), ordered };
  }
  return { ...draft, ordered: withBlockAt(draft.ordered, index, before > index ? before - 1 : before) };
}
