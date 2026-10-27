// The plan lifecycle as the server declares it (manifests/platform/plan-lifecycle.json), received in
// the plans snapshot's `lifecycle` projection. Every page that shows plans sets it once from its
// snapshot, so tabs, labels, priority display, and copy-prompt actions never carry their own copy.
//
// Before a snapshot arrives nothing plan-shaped is rendered, so the fallbacks below only keep an
// early call from throwing: an id stands in for its label, and no actions are offered.

let states = [];
let byId = new Map();

export function setLifecycleModel(projection) {
  states = Array.isArray(projection?.states) ? projection.states : [];
  byId = new Map(states.map((state) => [state.id, state]));
}

export function isLifecycle(id) {
  return byId.has(id);
}

export function lifecycleLabel(id) {
  return byId.get(id)?.label || id;
}

// Every state in declared order, with whether it is a primary tab or sits in the overflow menu.
export function lifecycleTabs() {
  return states.map(({ id, tab }) => ({ id, secondary: tab !== "primary" }));
}

// Priority only applies before implementation; the manifest declares those states.
export function showsPriority(id) {
  return byId.get(id)?.showsPriority ?? false;
}

// The copy-prompt actions a state offers: [{ command, label, description }].
export function lifecycleActions(id) {
  return byId.get(id)?.actions || [];
}
