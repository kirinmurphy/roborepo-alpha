// The Backlog ordering calculations: which same-namespace plans must move together, and what the
// effective order is once the saved order meets the current plans. Everything here is pure, so a
// portal read, a Save, and `roborepo plans order place` all reach the same answer from the same
// inputs. Reading and writing plans/plans-order.json lives in backlog-registry.mjs.
//
// A plan's namespace is the only scope a rank has. Dependency edges connect plans into one movable
// group only when both ends are in the same namespace's Backlog, so a prerequisite that has left
// Backlog never joins its dependents, and a cross-namespace edge never merges two orders.

// Dependency cycles among plans shaped { id, dependencies }, each as a closed path: [a, b, a]. A
// self-reference has its own finding and is not reported here. Exported for any caller that needs to
// reason about the dependency graph, not only ordering.
export function findDependencyCycles(plans) {
  const edges = new Map();
  for (const plan of plans) {
    if (plan.id) edges.set(plan.id, [...new Set(plan.dependencies || [])].filter((dep) => dep !== plan.id).sort());
  }
  const state = new Map();
  const cycles = new Map();
  const walk = (id, trail) => {
    state.set(id, "open");
    for (const dep of edges.get(id) || []) {
      if (!edges.has(dep)) continue;
      if (state.get(dep) === "open") {
        const cycle = trail.slice(trail.indexOf(dep));
        // One entry per cycle whichever member the walk reached first.
        const start = cycle.indexOf([...cycle].sort()[0]);
        const canonical = [...cycle.slice(start), ...cycle.slice(0, start)];
        cycles.set(canonical.join("\0"), [...canonical, canonical[0]]);
      } else if (!state.has(dep)) {
        walk(dep, [...trail, dep]);
      }
    }
    state.set(id, "done");
  };
  for (const id of [...edges.keys()].sort()) if (!state.has(id)) walk(id, [id]);
  return [...cycles.values()];
}

// `plans` is every plan in one repository, shaped { id, namespace, lifecycle, dependencies }, so a
// reference to a plan outside Backlog is not mistaken for a missing one. Returns:
//   groups      connected components of direct edges among rankable plans in `lifecycle`:
//               { namespace, ids, edges: [[prerequisite, dependent]], cyclic }
//   unrankable  plans in `lifecycle` with an approved namespace but no usable id
//   cycles      closed paths from findDependencyCycles, among the rankable plans
//   missing     { id, dependency } for each reference to a plan the repository does not have
export function deriveGroups(plans, lifecycle = "backlog") {
  const idCounts = new Map();
  for (const plan of plans) if (plan.id) idCounts.set(plan.id, (idCounts.get(plan.id) || 0) + 1);
  const current = plans.filter((plan) => plan.lifecycle === lifecycle && plan.namespace);
  const rankable = current.filter((plan) => plan.id && idCounts.get(plan.id) === 1);
  const unrankable = current.filter((plan) => !rankable.includes(plan));
  const byId = new Map(rankable.map((plan) => [plan.id, plan]));

  const parent = new Map(rankable.map((plan) => [plan.id, plan.id]));
  const rootOf = (id) => {
    let root = id;
    while (parent.get(root) !== root) root = parent.get(root);
    parent.set(id, root);
    return root;
  };
  const edges = [];
  for (const plan of rankable) {
    for (const dep of new Set(plan.dependencies || [])) {
      const prerequisite = byId.get(dep);
      if (!prerequisite || dep === plan.id || prerequisite.namespace !== plan.namespace) continue;
      edges.push([dep, plan.id]);
      parent.set(rootOf(dep), rootOf(plan.id));
    }
  }

  const cycles = findDependencyCycles(rankable.map((plan) => ({
    id: plan.id,
    dependencies: (plan.dependencies || []).filter((dep) => byId.get(dep)?.namespace === plan.namespace),
  })));
  const inCycle = new Set(cycles.flat());
  const components = new Map();
  for (const plan of rankable) {
    const root = rootOf(plan.id);
    if (!components.has(root)) components.set(root, { namespace: plan.namespace, ids: [], edges: [], cyclic: false });
    const group = components.get(root);
    group.ids.push(plan.id);
    if (inCycle.has(plan.id)) group.cyclic = true;
  }
  for (const edge of edges) components.get(rootOf(edge[0])).edges.push(edge);
  const groups = [...components.values()];
  for (const group of groups) group.ids.sort();

  const missing = current.flatMap((plan) => (plan.dependencies || [])
    .filter((dep) => dep !== plan.id && !idCounts.has(dep))
    .map((dependency) => ({ id: plan.id, dependency, namespace: plan.namespace })));
  return { groups, unrankable, cycles, missing };
}

// The effective order for one namespace: `savedOrder` reconciled against that namespace's `groups`,
// with `change` applied when there is one. Writes nothing. Returns:
//   order     every ranked id, each connected group contiguous and topologically valid
//   moves     how `order` differs from `savedOrder`, for the automatic-move notice
//   findings  why `change` cannot stand; a caller must not persist a proposal that has any
//
// `change` is null, { type: "place", id, position: "top" | "bottom" }, or
// { type: "replace", order, unprioritized }. `unprioritized` names the ranked plans the caller means to
// take out of the order; any other ranked plan missing from `order` is refused, so a bug or a stale
// client cannot demote a plan by leaving it out. Part of a linked group cannot be taken out alone,
// since the rest of the group would pull it straight back in.
//
// A connected group with any ranked member is ranked, anchored at its earliest ranked member, and
// its other members join it there. A group with none stays unranked. A group containing a cycle has
// no valid sequence, so its members keep the positions they already have and none is pulled in.
export function proposeOrder(savedOrder, groups, change = null) {
  const groupOf = new Map();
  for (const group of groups) for (const id of group.ids) groupOf.set(id, group);
  const stored = [...new Set(savedOrder)].filter((id) => groupOf.has(id));
  const findings = [];
  const requested = applyChange(stored, groupOf, change, findings);
  const order = reconcile(requested, groupOf);

  if (change?.type === "replace" && findings.length === 0) {
    if (order.join("\0") !== requested.join("\0")) {
      findings.push({ code: "ORDER_SPLITS_DEPENDENCIES", message: "That order separates linked plans or puts a plan before its prerequisite." });
    }
    const unranked = reconcile(stored, groupOf).filter((id) => !requested.includes(id) && !change.unprioritized?.includes(id));
    if (unranked.length) findings.push({ code: "ORDER_DROPS_PLANS", message: `That order leaves out ranked plans: ${unranked.join(", ")}.` });
  }
  return { order, moves: describeMoves(stored, order), findings };
}

function applyChange(stored, groupOf, change, findings) {
  if (!change) return stored;
  if (change.type === "replace") {
    const unknown = change.order.filter((id) => !groupOf.has(id));
    if (unknown.length) {
      findings.push({ code: "ORDER_UNKNOWN_PLANS", message: `That order names plans outside this namespace's Backlog: ${unknown.join(", ")}.` });
      return stored;
    }
    if (new Set(change.order).size !== change.order.length) {
      findings.push({ code: "ORDER_REPEATS_PLANS", message: "That order lists a plan more than once." });
      return stored;
    }
    return change.order;
  }
  const group = groupOf.get(change.id);
  if (!group) {
    findings.push({ code: "ORDER_UNKNOWN_PLANS", message: `That plan is not in this namespace's Backlog: ${change.id}.` });
    return stored;
  }
  const rest = stored.filter((id) => !group.ids.includes(id));
  const rank = new Map(stored.map((id, index) => [id, index]));
  const moved = group.cyclic ? [change.id] : sequenceGroup(group, rank);
  return change.position === "top" ? [...moved, ...rest] : [...rest, ...moved];
}

function reconcile(requested, groupOf) {
  const rank = new Map(requested.map((id, index) => [id, index]));
  const order = [];
  const placed = new Set();
  for (const id of requested) {
    const group = groupOf.get(id);
    if (group.cyclic) {
      order.push(id);
    } else if (!placed.has(group)) {
      placed.add(group);
      order.push(...sequenceGroup(group, rank));
    }
  }
  return order;
}

// A stable topological sort: of the plans whose prerequisites are done, the highest-ranked comes
// next, then unranked plans by id, so independent members keep the order they already had.
export function sequenceGroup(group, rank = new Map()) {
  const remaining = new Map(group.ids.map((id) => [id, 0]));
  const dependents = new Map(group.ids.map((id) => [id, []]));
  for (const [prerequisite, dependent] of group.edges) {
    remaining.set(dependent, remaining.get(dependent) + 1);
    dependents.get(prerequisite).push(dependent);
  }
  const compare = (a, b) => (rank.get(a) ?? Infinity) - (rank.get(b) ?? Infinity) || a.localeCompare(b);
  const ready = group.ids.filter((id) => remaining.get(id) === 0);
  const sequence = [];
  while (ready.length) {
    ready.sort(compare);
    const id = ready.shift();
    sequence.push(id);
    for (const dependent of dependents.get(id)) {
      remaining.set(dependent, remaining.get(dependent) - 1);
      if (remaining.get(dependent) === 0) ready.push(dependent);
    }
  }
  // Only a cycle leaves members behind; they stay listed so the plans remain visible.
  return [...sequence, ...group.ids.filter((id) => !sequence.includes(id)).sort(compare)];
}

// Plans new to the order, plus plans that truly changed places: those outside the longest run that
// kept its relative order. Plans merely pushed along by an insertion are not moves.
function describeMoves(stored, order) {
  const position = new Map(order.map((id, index) => [id, index]));
  const kept = longestIncreasingRun(stored.map((id) => position.get(id)));
  const moves = [];
  stored.forEach((id, index) => {
    if (!kept.has(index)) moves.push({ id, kind: "moved", from: index, to: position.get(id) });
  });
  const known = new Set(stored);
  order.forEach((id, index) => {
    if (!known.has(id)) moves.push({ id, kind: "attached", from: null, to: index });
  });
  return moves;
}

// Indexes of one longest increasing subsequence. Orders are at most a few hundred plans.
function longestIncreasingRun(values) {
  const best = values.map(() => 1);
  const previous = values.map(() => -1);
  let end = -1;
  values.forEach((value, index) => {
    for (let earlier = 0; earlier < index; earlier += 1) {
      if (values[earlier] < value && best[earlier] + 1 > best[index]) {
        best[index] = best[earlier] + 1;
        previous[index] = earlier;
      }
    }
    if (end === -1 || best[index] > best[end]) end = index;
  });
  const kept = new Set();
  for (let index = end; index !== -1; index = previous[index]) kept.add(index);
  return kept;
}

// Splits a sequence of ids into display blocks: each maximal run from one connected group.
export function blocksFromSequence(ids, groups) {
  const groupOf = new Map();
  for (const group of groups) for (const id of group.ids) groupOf.set(id, group);
  const blocks = [];
  for (const id of ids) {
    const last = blocks.at(-1);
    if (last && groupOf.get(last.ids[0]) === groupOf.get(id)) last.ids.push(id);
    else blocks.push({ ids: [id] });
  }
  return blocks;
}
