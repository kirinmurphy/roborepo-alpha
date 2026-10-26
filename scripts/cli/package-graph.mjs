// Pure dependency-graph helpers over plain `{ id, requires, recommends }` nodes. Package state
// (package-state.mjs) and install bundles (presets.mjs) both record only what the user selected and
// derive everything those selections require through these functions, so the two records follow one
// rule. Nothing here reads files, writes files, or prompts.
//
// Ids a node references but the node list does not contain are skipped: catalog validation reports
// them, and a missing dependency must not make a read path throw.

function nodeMap(nodes) {
  return nodes instanceof Map ? nodes : new Map(nodes.map((node) => [node.id, node]));
}

function edges(node, relation) {
  return Array.isArray(node?.[relation]) ? node[relation] : [];
}

// Selected roots plus every package they require, directly or transitively. Dependencies come
// before the packages that require them, so applying in this order never applies a package ahead
// of what it needs; reverse it to remove dependents first. Unknown root ids are dropped.
export function requiredClosure(nodes, rootIds) {
  const byId = nodeMap(nodes);
  const out = [];
  const visited = new Set();
  function visit(id) {
    if (visited.has(id) || !byId.has(id)) return;
    visited.add(id);
    for (const dep of edges(byId.get(id), "requires")) visit(dep);
    out.push(id);
  }
  for (const id of rootIds) visit(id);
  return out;
}

// The selected roots in a legacy record that listed dependencies alongside the packages that
// pulled them in: every listed id that another listed, non-excluded id requires (directly or
// transitively) is dropped, because it stays in the required closure through that parent.
export function dropRequiredIds(nodes, listedIds, { excluded = [] } = {}) {
  const off = new Set(excluded);
  const listed = [...new Set(listedIds)].filter((id) => !off.has(id));
  const required = new Set();
  for (const id of listed) {
    for (const dep of requiredClosure(nodes, [id])) if (dep !== id) required.add(dep);
  }
  return listed.filter((id) => !required.has(id));
}

function inverse(nodes, relation, targetId, activeIds) {
  const active = activeIds ? new Set(activeIds) : null;
  const out = [];
  for (const node of nodeMap(nodes).values()) {
    if (active && !active.has(node.id)) continue;
    if (edges(node, relation).includes(targetId)) out.push(node.id);
  }
  return out;
}

// Ids that list `targetId` in `requires`. With `activeIds`, only those ids count.
export function requiredBy(nodes, targetId, { activeIds } = {}) {
  return inverse(nodes, "requires", targetId, activeIds);
}

// Ids that list `targetId` in `recommends`. With `activeIds`, only those ids count.
export function recommendedBy(nodes, targetId, { activeIds } = {}) {
  return inverse(nodes, "recommends", targetId, activeIds);
}

// Selected roots whose required closure contains `targetId`, other than `targetId` itself: the
// packages that keep it effective. A disable that removes these turns the target off.
export function rootsRequiring(nodes, targetId, rootIds) {
  return rootIds.filter((id) => id !== targetId && requiredClosure(nodes, [id]).includes(targetId));
}

// Cycles in `requires`, each as the id path that closes it. `recommends` never takes part:
// a recommendation is an offer, so two packages may recommend each other.
export function requiresCycles(nodes) {
  const byId = nodeMap(nodes);
  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id, stack) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      cycles.push([...stack, id]);
      return;
    }
    visiting.add(id);
    for (const dep of edges(byId.get(id), "requires")) {
      if (byId.has(dep)) visit(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const id of byId.keys()) visit(id, []);
  return cycles;
}
