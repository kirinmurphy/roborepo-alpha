// The plan lifecycle, declared once in manifests/platform/plan-lifecycle.json: each state's folder,
// label, tab, priority display, worktree binding, and portal copy-prompt actions, plus the
// transitions between states and the commands that perform them.
//
// The manifest names states; it does not encode rules. Destination validators stay in
// lifecycle-policy.mjs and Git behavior stays in transition.mjs, both keyed by the ids declared
// here. Loading validates the shape and fails loudly, because every lifecycle list in the domain
// module and the portal reads from the compiled model.
import fs from "node:fs";

const MANIFEST_URL = new URL("../../manifests/platform/plan-lifecycle.json", import.meta.url);
const SUPPORTED_SCHEMA = 1;
const TABS = new Set(["primary", "overflow"]);
const SLUG = /^[a-z][a-z0-9-]*$/;

export function loadLifecycleManifest(url = MANIFEST_URL) {
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(url, "utf8"));
  } catch (err) {
    throw new Error(`plan lifecycle manifest could not be read: ${err.message}`);
  }
  validateLifecycleManifest(manifest);
  return manifest;
}

// Throws on the first problem, naming the offending entry.
export function validateLifecycleManifest(manifest) {
  const fail = (message) => { throw new Error(`plan lifecycle manifest: ${message}`); };
  if (manifest?.schemaVersion !== SUPPORTED_SCHEMA) fail(`schemaVersion must be ${SUPPORTED_SCHEMA}`);
  if (!Array.isArray(manifest.states) || manifest.states.length === 0) fail("states must be a non-empty array");
  const ids = new Set();
  const folders = new Set();
  for (const state of manifest.states) {
    if (!SLUG.test(state?.id || "")) fail(`state id must be a lowercase slug: ${JSON.stringify(state?.id)}`);
    if (ids.has(state.id)) fail(`duplicate state id: ${state.id}`);
    ids.add(state.id);
    if (state.folder !== null) {
      if (state.folder !== state.id) fail(`${state.id}: folder must equal the state id, or be null for a state with no folder`);
      folders.add(state.folder);
    }
    if (typeof state.label !== "string" || !state.label.trim()) fail(`${state.id}: label is required`);
    if (!TABS.has(state.tab)) fail(`${state.id}: tab must be primary or overflow`);
    for (const key of ["showsPriority", "worktreeBound"]) {
      if (typeof state[key] !== "boolean") fail(`${state.id}: ${key} must be a boolean`);
    }
    if (!Array.isArray(state.actions)) fail(`${state.id}: actions must be an array`);
    for (const action of state.actions) {
      if (!SLUG.test(action?.command || "")) fail(`${state.id}: action command must be a slug`);
      for (const key of ["label", "description"]) {
        if (typeof action[key] !== "string" || !action[key].trim()) fail(`${state.id}: action ${action.command} needs a ${key}`);
      }
    }
  }
  if (!Array.isArray(manifest.transitions)) fail("transitions must be an array");
  const transitionIds = new Set();
  for (const transition of manifest.transitions) {
    if (!SLUG.test(transition?.id || "")) fail(`transition id must be a slug: ${JSON.stringify(transition?.id)}`);
    if (transitionIds.has(transition.id)) fail(`duplicate transition id: ${transition.id}`);
    transitionIds.add(transition.id);
    // A plan only ever moves between folders; a state without one is a place a plan is found, never sent.
    if (!folders.has(transition.to)) fail(`${transition.id}: destination ${transition.to} is not a state with a folder`);
    if (!Array.isArray(transition.from) || transition.from.length === 0) fail(`${transition.id}: from must be a non-empty array`);
    for (const source of transition.from) {
      if (!folders.has(source)) fail(`${transition.id}: source ${source} is not a state with a folder`);
      if (source === transition.to) fail(`${transition.id}: a transition cannot start and end in ${source}`);
    }
    if (!Array.isArray(transition.commands) || transition.commands.length === 0 || !transition.commands.every((command) => SLUG.test(command))) {
      fail(`${transition.id}: commands must be a non-empty array of slugs`);
    }
  }
}

// Pure: turns a validated manifest into frozen lookups. Nothing here touches the filesystem.
export function compileLifecycleModel(manifest) {
  const states = manifest.states.map((state) => deepFreeze({ ...state, actions: state.actions.map((action) => ({ ...action })) }));
  const byId = new Map(states.map((state) => [state.id, state]));
  const transitions = manifest.transitions.map((transition) => deepFreeze({ ...transition, from: [...transition.from], commands: [...transition.commands] }));
  const transitionsById = new Map(transitions.map((transition) => [transition.id, transition]));
  return Object.freeze({
    states: Object.freeze(states),
    stateIds: Object.freeze(states.map((state) => state.id)),
    folders: Object.freeze(new Set(states.filter((state) => state.folder).map((state) => state.folder))),
    worktreeBound: Object.freeze(new Set(states.filter((state) => state.worktreeBound).map((state) => state.id))),
    transitions: Object.freeze(transitions),
    state: (id) => byId.get(id) || null,
    transition: (id) => transitionsById.get(id) || null,
    transitionsFrom: (id) => transitions.filter((transition) => transition.from.includes(id)),
  });
}

// What the plans snapshot publishes: plain data only, so the portal reads the same states, tabs,
// and actions without carrying its own copy.
export function lifecycleProjection(model) {
  return {
    states: model.states.map(({ id, label, tab, showsPriority, worktreeBound, actions }) => ({
      id,
      label,
      tab,
      showsPriority,
      worktreeBound,
      actions: actions.map(({ command, label: actionLabel, description }) => ({ command, label: actionLabel, description })),
    })),
    transitions: model.transitions.map(({ id, from, to, commands }) => ({ id, from: [...from], to, commands: [...commands] })),
  };
}

export const LIFECYCLE_MODEL = compileLifecycleModel(loadLifecycleManifest());

function deepFreeze(value) {
  for (const child of Object.values(value)) if (child && typeof child === "object") deepFreeze(child);
  return Object.freeze(value);
}
