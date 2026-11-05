// The Backlog's view model: which directory level the URL names, what each level counts, and the
// edits a Prioritize draft allows. Pure, with no DOM and no requests, so the rules run in Node checks.
// The order itself comes from the server (snapshot.backlog); nothing here recomputes dependencies.
// A draft holds the server's blocks and only ever moves whole blocks, which is what keeps linked
// plans contiguous and prerequisites ahead of their dependents.

import { ALL_REPOSITORIES, repositoryScopeChoices } from "../shared/repository-scope-choices.js";

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

function pendingKeys(view) {
  return [...view.needsPrioritization.flatMap((block) => block.keys), ...view.unrankable];
}

// A plan's unfinished prerequisites in its own repo, each with its namespace. Only a completed plan
// satisfies a prerequisite. A missing one stays listed, with no plan to open. Status names the
// lifecycle in every case, Backlog included, so a list mixing Backlog and Active plans reads evenly.
export function openPrerequisites(record, allRecords) {
  const repositoryRecords = allRecords.filter((item) => item.repository.id === record.repository.id);
  return (record.plan.dependencies || []).flatMap((id) => {
    const target = repositoryRecords.find((item) => item.plan.id === id);
    if (!target) return [{ id, key: null, label: id, namespace: null, lifecycle: null, status: "not found" }];
    if (target.plan.lifecycle === "completed") return [];
    return [{
      id,
      key: target.key,
      label: target.plan.title,
      namespace: target.plan.namespace,
      lifecycle: target.plan.lifecycle,
      status: target.plan.lifecycle.charAt(0).toUpperCase() + target.plan.lifecycle.slice(1),
    }];
  });
}

// How one block's plans are drawn: a file-system style tree, in display order. Each row is
// { key, parentKey, alsoNeeds, lines }, where `lines` holds the "pipe" | "blank" | "tee" | "elbow"
// guides to its left. A prerequisite already implied through another one is dropped, so if E needs A
// and C, and C needs A, then E sits under C alone.
//
// A plan can still have several real prerequisites, and a tree gives it one parent. It nests under
// whichever finishes last, and the rest are named in `alsoNeeds`. Walking depth-first, and placing a
// plan only once all its prerequisites are placed, keeps every subtree contiguous and every
// prerequisite above its dependents. Plans with no order between them keep their saved order.
export function dependencyTree(keys, records) {
  const keyOfId = new Map(keys.map((key) => [records.get(key).plan.id, key]));
  const saved = new Map(keys.map((key, index) => [key, index]));
  const prerequisites = new Map(keys.map((key) => [key, [...new Set(records.get(key).plan.dependencies || [])]
    .map((id) => keyOfId.get(id))
    .filter((prerequisite) => prerequisite && prerequisite !== key)]));
  const dependents = new Map(keys.map((key) => [key, []]));
  for (const [key, needs] of prerequisites) for (const prerequisite of needs) dependents.get(prerequisite).push(key);
  const ancestors = (key, seen = new Set()) => {
    for (const prerequisite of prerequisites.get(key)) {
      if (!seen.has(prerequisite)) {
        seen.add(prerequisite);
        ancestors(prerequisite, seen);
      }
    }
    return seen;
  };
  const directNeeds = (key) => {
    const needs = prerequisites.get(key);
    return needs.filter((need) => !needs.some((other) => other !== need && ancestors(other).has(need)));
  };

  const waiting = new Map(keys.map((key) => [key, prerequisites.get(key).length]));
  const stack = keys.filter((key) => !waiting.get(key)).reverse();
  const rows = new Map();
  while (stack.length) {
    const key = stack.pop();
    const placedOrder = [...rows.keys()];
    const needs = directNeeds(key);
    const parentKey = needs.reduce((latest, need) => (latest === null || placedOrder.indexOf(need) > placedOrder.indexOf(latest) ? need : latest), null);
    rows.set(key, { key, parentKey, alsoNeeds: needs.filter((need) => need !== parentKey), lines: [] });
    const ready = dependents.get(key).filter((dependent) => {
      waiting.set(dependent, waiting.get(dependent) - 1);
      return waiting.get(dependent) === 0;
    });
    stack.push(...ready.sort((a, b) => saved.get(b) - saved.get(a)));
  }
  // Only a cycle leaves plans unplaced. It locks the namespace, and the plans stay visible at the root.
  for (const key of keys) if (!rows.has(key)) rows.set(key, { key, parentKey: null, alsoNeeds: [], lines: [] });

  const lastChild = new Map();
  for (const row of rows.values()) if (row.parentKey) lastChild.set(row.parentKey, row.key);
  for (const row of rows.values()) {
    if (!row.parentKey) continue;
    const inherited = rows.get(row.parentKey).lines.map((line) => (line === "tee" || line === "pipe" ? "pipe" : "blank"));
    row.lines = [...inherited, lastChild.get(row.parentKey) === row.key ? "elbow" : "tee"];
  }
  return [...rows.values()];
}

// The repos the repo breadcrumb can switch to: [value, label] pairs, with the selector's sorting and
// its labels for two repos of one name.
export function repositoryOptions(repositories) {
  const choices = repositoryScopeChoices((repositories || []).map(({ urlKey, name }) => ({ urlKey, displayName: name })));
  return choices.filter(([value]) => value !== ALL_REPOSITORIES);
}

// The levels the namespace breadcrumb can switch between: [value, label] pairs in directory order.
export function namespaceOptions(entry) {
  const options = entry.namespaces.filter((view) => keysOfView(view).length).map((view) => [view.namespace, view.namespace.toUpperCase()]);
  return entry.noNamespace.length ? [...options, [NO_NAMESPACE, "No namespace"]] : options;
}

const IN_FLIGHT = new Set(["ready", "active", "review"]);

// Buildable now: no blocker, and every prerequisite finished. Directory counts and the Blockers filter
// read this, so they agree with the plan's own `Waiting on` list.
export function isUnblocked(record, allRecords) {
  return !record.plan.blockers.length && !openPrerequisites(record, allRecords).length;
}

// Nothing in Backlog holds this plan up: whatever is unfinished is already underway, so it can be
// what a namespace does next even though it cannot start today.
function canBeNext(record, allRecords) {
  return !record.plan.blockers.length && openPrerequisites(record, allRecords).every((item) => IN_FLIGHT.has(item.lifecycle));
}

// Ready to build: already prioritized, with nothing holding it up.
function countReady(keys, views, allRecords) {
  const records = new Map(allRecords.map((record) => [record.key, record]));
  const ranked = new Set(views.flatMap((view) => view.ordered.flatMap((block) => block.keys)));
  return keys.filter((key) => ranked.has(key) && isUnblocked(records.get(key), allRecords)).length;
}

// Each namespace's highest-ranked plan that can be next. Only a ranked plan qualifies, since an
// unranked one has no claim to be next. Namespaces stay in directory order, so pinned ones lead.
export function nextUp(entry, allRecords, matchingKeys) {
  const records = new Map(allRecords.map((record) => [record.key, record]));
  return entry.namespaces.flatMap((view) => {
    const first = view.ordered.flatMap((block) => block.keys).find((key) => matchingKeys.has(key) && canBeNext(records.get(key), allRecords));
    return first ? [records.get(first)] : [];
  });
}

// The plans outside `block` still waiting on one of its plans, which archiving it would leave stranded.
export function dependentsOutside(block, allRecords) {
  const ids = new Set(block.ids);
  const repository = allRecords.find((record) => record.key === block.keys[0])?.repository.id;
  return allRecords.filter((record) => record.repository.id === repository
    && !ids.has(record.plan.id)
    && !["completed", "archived"].includes(record.plan.lifecycle)
    && (record.plan.dependencies || []).some((id) => ids.has(id)));
}

// Repositories with Backlog plans among `matchingKeys`, the plans the Filters popup leaves.
export function repositoryDirectory(backlog, matchingKeys, allRecords) {
  return backlog
    .map((entry) => {
      const pending = new Set(entry.namespaces.flatMap(pendingKeys));
      const keys = [...entry.namespaces.flatMap(keysOfView), ...entry.noNamespace].filter((key) => matchingKeys.has(key));
      return {
        repositoryId: entry.repositoryId,
        name: entry.name,
        urlKey: entry.urlKey,
        planCount: keys.length,
        readyCount: countReady(keys, entry.namespaces, allRecords),
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
export function namespaceDirectory(entry, matchingKeys, allRecords) {
  const rows = entry.namespaces.map((view) => {
    const pending = new Set(pendingKeys(view));
    const keys = keysOfView(view).filter((key) => matchingKeys.has(key));
    return {
      namespace: view.namespace,
      pinned: Boolean(view.pinned),
      planCount: keys.length,
      readyCount: countReady(keys, [view], allRecords),
      unprioritizedCount: keys.filter((key) => pending.has(key)).length,
    };
  }).filter((row) => row.planCount > 0);
  const repair = entry.noNamespace.filter((key) => matchingKeys.has(key));
  if (repair.length) rows.push({ namespace: NO_NAMESPACE, planCount: repair.length, readyCount: 0, unprioritizedCount: 0 });
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

// Ranked plans the draft has returned to Needs prioritization. Save names them, because the server
// refuses an order that merely leaves a ranked plan out.
export function unprioritizedIds(draft) {
  const ordered = new Set(orderedIds(draft));
  return draft.committedIds.filter((id) => !ordered.has(id));
}

// The draft has something to save: a changed order, or a plan placed out of Needs prioritization.
export function isDraftDirty(draft) {
  return Boolean(draft) && orderedIds(draft).join("\0") !== draft.committedIds.join("\0");
}

// The actions each section's block offers, in the order their controls appear. "place-top" is the
// Needs prioritization control labelled Move down: it moves the block down into Prioritized, at its top.
export const ORDERED_ACTIONS = ["top", "up", "down", "bottom", "return"];
export const NEEDS_ACTIONS = ["place-top", "bottom"];

export function isActionEnabled(section, action, index, count) {
  if (section === "needs" || action === "return") return true;
  if (action === "top" || action === "up") return index > 0;
  return index < count - 1;
}

export function moveBlock(draft, section, index, action) {
  if (section === "needs") {
    const block = draft.needs[index];
    const needs = draft.needs.filter((_, position) => position !== index);
    return { ...draft, needs, ordered: action === "place-top" ? [block, ...draft.ordered] : [...draft.ordered, block] };
  }
  if (action === "return") return returnBlock(draft, index);
  const targets = { top: 0, up: index - 1, down: index + 1, bottom: draft.ordered.length - 1 };
  return { ...draft, ordered: withBlockAt(draft.ordered, index, targets[action]) };
}

// Back to the top of Needs prioritization, whether by the control or the drop zone below the list.
export function returnBlock(draft, index) {
  return {
    ...draft,
    needs: [draft.ordered[index], ...draft.needs],
    ordered: draft.ordered.filter((_, position) => position !== index),
  };
}

function withBlockAt(blocks, from, to) {
  const next = blocks.filter((_, position) => position !== from);
  next.splice(to, 0, blocks[from]);
  return next;
}

// A drop inserts before the block now at `before`, counted in the Prioritized list as drawn while the
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
