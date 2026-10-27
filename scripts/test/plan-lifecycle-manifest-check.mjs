#!/usr/bin/env node
// The plan lifecycle manifest (manifests/platform/plan-lifecycle.json): it loads and validates, its
// compiled lookups are what the domain module and the portal read, every state with a folder has a
// destination validator, every transition has rules, and malformed manifests fail loudly.
import assert from "node:assert/strict";
import {
  LIFECYCLE_MODEL,
  compileLifecycleModel,
  lifecycleProjection,
  loadLifecycleManifest,
  validateLifecycleManifest,
} from "../../modules/plan-suite/lifecycle-manifest.mjs";
import { lifecyclePolicies } from "../../modules/plan-suite/lifecycle-policy.mjs";
import { LIFECYCLES, PLAN_SUITE_COMMANDS, lifecycleFromPath } from "../../modules/plan-suite/index.mjs";
import { TRANSITION_RULES } from "../../modules/plan-suite/transition-rules.mjs";

const manifest = loadLifecycleManifest();
assert.deepEqual(LIFECYCLE_MODEL.states.filter((state) => state.showsPriority).map((state) => state.id), ["backlog", "ready"], "priority only applies before implementation starts");

// The lifecycle itself.
assert.deepEqual(LIFECYCLE_MODEL.stateIds, ["backlog", "ready", "active", "review", "completed", "archived", "unclassified"]);
assert.deepEqual([...LIFECYCLES], ["backlog", "ready", "active", "review", "completed", "archived"], "every state but unclassified is a folder");
assert.equal(lifecycleFromPath("docs/plans/review/x.md"), "review", "lifecycle is still derived from the folder");
assert.equal(lifecycleFromPath("docs/plans/x.md"), "unclassified");
assert.deepEqual([...LIFECYCLE_MODEL.worktreeBound], ["active", "review"], "Active and Review hold a worktree");
assert.deepEqual(LIFECYCLE_MODEL.states.filter((state) => state.tab === "primary").map((state) => state.id), ["backlog", "ready", "active", "review"]);

const edges = LIFECYCLE_MODEL.transitions.flatMap((transition) => transition.from.map((from) => `${from}->${transition.to}`)).sort();
assert.deepEqual(edges, [
  "active->archived", "active->review", "backlog->archived", "backlog->ready",
  "ready->active", "ready->archived", "review->active", "review->archived", "review->completed",
].sort(), "exactly the documented moves");
assert.deepEqual(LIFECYCLE_MODEL.transitionsFrom("completed"), [], "completed is terminal");
assert.ok(!LIFECYCLE_MODEL.transitions.some((transition) => transition.to === "unclassified"), "unclassified is never a destination");

// Every declared state and transition is backed by code.
for (const folder of LIFECYCLES) assert.ok(lifecyclePolicies[folder], `${folder} has a destination validator`);
assert.deepEqual(Object.keys(TRANSITION_RULES).sort(), LIFECYCLE_MODEL.transitions.map((transition) => transition.id).sort(), "every transition has rules");

// The portal's copy-prompt actions are the suite commands a prompt may open with.
assert.deepEqual([...PLAN_SUITE_COMMANDS].sort(), ["plan-archive", "plan-close", "plan-execute", "plan-promote", "plan-review", "plan-write"]);
assert.ok(!PLAN_SUITE_COMMANDS.has("plan-start"), "the retired command is gone");
const actions = (id) => LIFECYCLE_MODEL.state(id).actions.map((action) => action.command);
assert.deepEqual(actions("backlog"), ["plan-promote", "plan-write", "plan-archive"]);
assert.deepEqual(actions("ready"), ["plan-execute", "plan-promote", "plan-archive"]);
assert.deepEqual(actions("active"), ["plan-execute", "plan-review", "plan-write", "plan-archive"]);
assert.deepEqual(actions("review"), ["plan-review", "plan-execute", "plan-close", "plan-archive"]);
for (const id of ["completed", "archived", "unclassified"]) assert.deepEqual(actions(id), [], `${id} offers no actions`);

// The compiled model is immutable and the projection is plain data that round-trips through JSON.
assert.ok(Object.isFrozen(LIFECYCLE_MODEL) && Object.isFrozen(LIFECYCLE_MODEL.states[0]) && Object.isFrozen(LIFECYCLE_MODEL.states[0].actions));
const projection = lifecycleProjection(LIFECYCLE_MODEL);
assert.deepEqual(JSON.parse(JSON.stringify(projection)), projection);
assert.deepEqual(projection.states.map((state) => state.id), LIFECYCLE_MODEL.stateIds);
assert.ok(!("folder" in projection.states[0]), "the portal never needs folder paths");
assert.notEqual(compileLifecycleModel(manifest), LIFECYCLE_MODEL, "compiling is pure: each call builds new lookups");

// Malformed manifests fail with the offending entry named.
const broken = (mutate) => {
  const copy = structuredClone(manifest);
  mutate(copy);
  return () => validateLifecycleManifest(copy);
};
assert.throws(broken((m) => { m.schemaVersion = 2; }), /schemaVersion must be 1/);
assert.throws(broken((m) => { m.states.push({ ...m.states[0] }); }), /duplicate state id: backlog/);
assert.throws(broken((m) => { m.states[1].folder = "elsewhere"; }), /ready: folder must equal the state id/);
assert.throws(broken((m) => { m.states[0].tab = "side"; }), /backlog: tab must be primary or overflow/);
assert.throws(broken((m) => { delete m.states[2].worktreeBound; }), /active: worktreeBound must be a boolean/);
assert.throws(broken((m) => { m.states[0].actions[0].label = ""; }), /backlog: action plan-promote needs a label/);
assert.throws(broken((m) => { m.transitions[0].to = "unclassified"; }), /promote: destination unclassified is not a state with a folder/);
assert.throws(broken((m) => { m.transitions[0].from = ["nowhere"]; }), /promote: source nowhere is not a state with a folder/);
assert.throws(broken((m) => { m.transitions[0].from = ["ready"]; }), /cannot start and end in ready/);
assert.throws(broken((m) => { m.transitions[0].commands = []; }), /promote: commands must be a non-empty array/);
assert.throws(broken((m) => { m.transitions.push({ ...m.transitions[0] }); }), /duplicate transition id: promote/);
assert.throws(() => loadLifecycleManifest(new URL("file:///nonexistent/plan-lifecycle.json")), /could not be read/);

console.log("plan lifecycle manifest: ok");
