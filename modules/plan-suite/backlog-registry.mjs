// docs/plans/plans-order.json, the one repository-local record of Backlog order: reading it, the
// Backlog index every read is built from, and the only writes it ever receives (a portal Save, a
// portal pin, and `roborepo plans order place`). The file lives in the primary checkout and stays uncommitted,
// like any other edit there; a lifecycle transition never touches it, which is why a plan that has
// left Backlog is ignored on read and pruned at the next write rather than removed when it moves.
//
//   Registry entry             Effective order            Next write
//   Plan now outside Backlog   ignored                    pruned
//   Unknown id                 excluded, with a finding   preserved
//   Plan with no namespace     excluded                   preserved after the rest, so a repair
//                                                         brings it back ranked
//   Namespace not approved     excluded, with a finding   preserved
//   Pin on a removed namespace ignored                    pruned
//
// `pinned` lists the namespaces lifted to the top of a repo's Backlog, first pinned first. It sets the
// order between namespaces only; each namespace's plans keep their own order.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { blocksFromSequence, deriveGroups, proposeOrder, sequenceGroup } from "./backlog-order.mjs";
import { finding } from "./findings.mjs";
import { domainError } from "./index.mjs";
import { PLANS_CONFIG_RELATIVE_PATH, approvedNamespaces, pathFreeFileError, readProjectNamespaces } from "./naming.mjs";

export const PLANS_ORDER_RELATIVE_PATH = "docs/plans/plans-order.json";
const SCHEMA_VERSION = 1;

// state is "missing", "ok", or "invalid". A missing file means every plan is unprioritized and no
// namespace is pinned; an invalid one reads the same way but refuses writes, so nothing overwrites
// what a person can repair.
export function readOrderRegistry(root) {
  let raw;
  try {
    raw = fs.readFileSync(path.join(root, PLANS_ORDER_RELATIVE_PATH), "utf8");
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "missing", namespaces: {}, pinned: [], raw: "" };
    return { state: "invalid", namespaces: {}, pinned: [], raw: "", error: pathFreeFileError(err) };
  }
  try {
    return { state: "ok", ...parseRegistry(raw), raw };
  } catch (err) {
    return { state: "invalid", namespaces: {}, pinned: [], raw, error: pathFreeFileError(err) };
  }
}

function parseRegistry(raw) {
  const data = JSON.parse(raw);
  if (data?.schemaVersion !== SCHEMA_VERSION) throw new Error(`schemaVersion must be ${SCHEMA_VERSION}`);
  const { namespaces } = data;
  if (!namespaces || typeof namespaces !== "object" || Array.isArray(namespaces)) throw new Error("`namespaces` must be an object");
  for (const [namespace, ids] of Object.entries(namespaces)) {
    if (!Array.isArray(ids) || !ids.every((id) => typeof id === "string" && id)) throw new Error(`\`namespaces.${namespace}\` must be an array of plan ids`);
  }
  const pinned = data.pinned ?? [];
  if (!Array.isArray(pinned) || !pinned.every((namespace) => typeof namespace === "string" && namespace)) throw new Error("`pinned` must be an array of namespaces");
  return { namespaces, pinned };
}

// The pins that still name an approved namespace. A namespace removed from the config drops out here
// at once, and from the file at its next write. A pin on an approved namespace with nothing in Backlog
// stays, so the namespace is still pinned when its next plan arrives.
function livePins(config, registry) {
  if (config.error) return [];
  const approved = new Set(approvedNamespaces(config.namespaces));
  return [...new Set(registry.pinned)].filter((namespace) => approved.has(namespace));
}

// Everything one repository's ordering decisions read, gathered once. `records` is every plan record
// in the repository, in all lifecycles, shaped { key, plan }.
function orderingContext(root, records) {
  const config = readProjectNamespaces(root);
  const registry = readOrderRegistry(root);
  const plans = records.map((record) => record.plan);
  const derived = deriveGroups(plans);
  return { root, records, config, registry, plans, derived, configRaw: readConfigBytes(root) };
}

function readConfigBytes(root) {
  try {
    return fs.readFileSync(path.join(root, PLANS_CONFIG_RELATIVE_PATH), "utf8");
  } catch {
    return "";
  }
}

// Any edit that could change what a Save means: the config, the registry, or a namespace plan's id,
// filename, or depends_on. An open draft carries this; a Save against any other value is refused.
function namespaceRevision(context, namespace) {
  const members = context.plans
    .filter((plan) => plan.lifecycle === "backlog" && plan.namespace === namespace)
    .map((plan) => [plan.id, path.basename(plan.relativePath), [...(plan.dependencies || [])].sort()])
    .sort((a, b) => a[1].localeCompare(b[1]));
  return crypto.createHash("sha256")
    .update(JSON.stringify([context.configRaw, context.registry.raw, members]))
    .digest("hex")
    .slice(0, 16);
}

// The Backlog as the portal renders it for one repository. Computed on every read and never written:
// a regrouping that dependency edits imply shows up here, and reaches the file at the next write.
export function buildBacklogIndex(root, records) {
  const context = orderingContext(root, records);
  const backlog = records.filter((record) => record.plan.lifecycle === "backlog");
  const pins = livePins(context.config, context.registry);
  const rank = (namespace) => (pins.includes(namespace) ? pins.indexOf(namespace) : pins.length);
  const namespaces = [...new Set(backlog.map((record) => record.plan.namespace).filter(Boolean))]
    .sort((a, b) => rank(a) - rank(b) || a.localeCompare(b))
    .map((namespace) => ({ ...namespaceView(context, namespace), pinned: pins.includes(namespace) }));
  return {
    config: { state: configState(context.config), ...(context.config.error ? { error: context.config.error } : {}) },
    registry: { state: context.registry.state, ...(context.registry.error ? { error: context.registry.error } : {}) },
    namespaces,
    noNamespace: backlog.filter((record) => !record.plan.namespace).map((record) => record.key),
    findings: registryFindings(context),
  };
}

function configState(config) {
  if (config.error) return "invalid";
  return config.namespaces.length ? "declared" : "none";
}

function namespaceView(context, namespace) {
  const { describe, groups, proposal, locked, reasons } = namespaceOrdering(context, namespace);
  const ranked = new Set(proposal.order);
  const pending = groups
    .map((group) => sequenceGroup({ ...group, ids: group.ids.filter((id) => !ranked.has(id)), edges: group.edges.filter((edge) => !edge.some((id) => ranked.has(id))) }))
    .filter((ids) => ids.length)
    .sort((a, b) => describe(a[0]).title.localeCompare(describe(b[0]).title) || a[0].localeCompare(b[0]));
  const unrankable = context.derived.unrankable.filter((plan) => plan.namespace === namespace);
  const keysOf = ({ ids }) => ({ ids, keys: ids.map((id) => describe(id).key) });
  return {
    namespace,
    revision: namespaceRevision(context, namespace),
    locked,
    reasons,
    // Refused by the registry or config rather than by this namespace's plans, so Save explains it.
    writable: context.registry.state !== "invalid" && !context.config.error,
    ordered: blocksFromSequence(proposal.order, groups).map(keysOf),
    needsPrioritization: pending.flatMap((ids) => blocksFromSequence(ids, groups)).map(keysOf),
    unrankable: unrankable.map((plan) => keyForPlan(context, plan)),
    moves: proposal.moves.map((move) => ({ ...move, key: describe(move.id).key })),
  };
}

function keyForPlan(context, plan) {
  return context.records.find((record) => record.plan === plan)?.key;
}

function namespaceOrdering(context, namespace) {
  const groups = context.derived.groups.filter((group) => group.namespace === namespace);
  const stored = context.registry.state === "ok" ? context.registry.namespaces[namespace] || [] : [];
  const proposal = proposeOrder(stored, groups);
  const inNamespace = new Set(groups.flatMap((group) => group.ids));
  const cycles = context.derived.cycles.filter((cycle) => inNamespace.has(cycle[0]));
  const missing = context.derived.missing.filter((item) => item.namespace === namespace);
  const reasons = [
    ...cycles.map((cycle) => `Dependency cycle: ${cycle.join(" -> ")}.`),
    ...missing.map((item) => `${item.id} depends on ${item.dependency}, which does not exist.`),
  ];
  const byId = new Map(context.records.map((record) => [record.plan.id, record]));
  return {
    describe: (id) => ({ key: byId.get(id).key, title: byId.get(id).plan.title }),
    groups,
    stored,
    proposal,
    locked: reasons.length > 0,
    reasons,
  };
}

function registryFindings(context) {
  const findings = [];
  if (context.config.error) findings.push(finding("INVALID_PLANS_CONFIG", { meta: { error: context.config.error } }));
  if (context.registry.state === "invalid") findings.push(finding("INVALID_ORDER_REGISTRY", { meta: { error: context.registry.error } }));
  if (context.config.error) return findings;
  const approved = new Set(approvedNamespaces(context.config.namespaces));
  const known = new Set(context.plans.map((plan) => plan.id).filter(Boolean));
  for (const [namespace, ids] of Object.entries(context.registry.namespaces)) {
    if (!approved.has(namespace)) {
      findings.push(finding("ORDER_UNAPPROVED_NAMESPACE", { meta: { namespace } }));
      continue;
    }
    for (const id of ids) if (!known.has(id)) findings.push(finding("ORDER_UNKNOWN_PLAN", { meta: { namespace, id } }));
  }
  return findings;
}

// The repository-level findings `roborepo plans validate` adds to its per-plan ones.
export function repositoryOrderFindings(root, records) {
  return registryFindings(orderingContext(root, records));
}

// Pins or unpins one namespace. It changes no plan's order, so it carries no revision.
export function setNamespacePinned({ root, namespace, pinned }) {
  const config = readProjectNamespaces(root);
  const registry = readOrderRegistry(root);
  assertRegistryWritable(config, registry);
  if (pinned && !approvedNamespaces(config.namespaces).includes(namespace)) throw domainError("INVALID_CHANGE", `${namespace} is not an approved namespace.`);
  const pins = livePins(config, registry);
  const next = pinned ? (pins.includes(namespace) ? pins : [...pins, namespace]) : pins.filter((item) => item !== namespace);
  writeRegistry(root, registry.namespaces, next);
  return { namespace, pinned: Boolean(pinned), written: true };
}

// A portal Save: the namespace's whole order, draft applied, or nothing. Refuses a stale draft.
export function saveNamespaceOrder({ root, records, namespace, order, unprioritized = [], revision }) {
  if (!isIdList(order)) throw domainError("INVALID_CHANGE", "order must be an array of plan ids.");
  if (!isIdList(unprioritized)) throw domainError("INVALID_CHANGE", "unprioritized must be an array of plan ids.");
  const context = orderingContext(root, records);
  assertRevision(context, namespace, revision);
  const { groups, stored } = assertWritable(context, namespace);
  const proposal = proposeOrder(stored, groups, { type: "replace", order, unprioritized });
  return applyOrder({ ...proposal, context, namespace }, namespaceRevision(context, namespace));
}

// `roborepo plans order place`. A plan connected to a ranked plan is already ranked by the effective
// order, so placing it only persists that; `position` applies to a plan that is not ranked yet, or
// to a whole group the caller explicitly moves. With no position an unranked plan stays unranked.
export function placePlan({ root, records, record, position = null }) {
  const context = orderingContext(root, records);
  const { plan } = record;
  if (plan.lifecycle !== "backlog") throw domainError("INVALID_CHANGE", `${plan.relativePath} is not in Backlog, so it has no place in an order.`);
  if (!plan.namespace) {
    throw domainError("INVALID_CHANGE", `${path.basename(plan.relativePath)} has no approved namespace, so it cannot be ordered.`, {
      resolution: "Rename the file to an approved `<namespace>-<slug>.md`, or add the namespace to docs/plans/plans-config.json.",
    });
  }
  if (context.derived.unrankable.includes(plan)) throw domainError("INVALID_CHANGE", `${path.basename(plan.relativePath)} needs a unique id before it can be ordered.`);
  const { groups, stored } = assertWritable(context, plan.namespace);
  const effective = proposeOrder(stored, groups);
  const attached = effective.order.includes(plan.id);
  const revision = namespaceRevision(context, plan.namespace);
  if (attached && !stored.includes(plan.id)) {
    const applied = applyOrder({ ...effective, context, namespace: plan.namespace }, revision);
    return { ...applied, placed: "attached", ignoredPosition: position };
  }
  if (!position) {
    if (attached) return { ...applyOrder({ ...effective, context, namespace: plan.namespace }, revision), placed: "ranked" };
    return { order: effective.order, moves: [], placed: "unprioritized", written: false };
  }
  const proposal = proposeOrder(stored, groups, { type: "place", id: plan.id, position });
  // The plan and its group moved because the caller asked; only what else moved is automatic.
  const placed = groups.find((group) => group.ids.includes(plan.id)).ids;
  const moves = proposal.moves.filter((move) => !placed.includes(move.id));
  return { ...applyOrder({ ...proposal, context, namespace: plan.namespace }, revision), moves, placed: position };
}

function isIdList(value) {
  return Array.isArray(value) && value.every((id) => typeof id === "string");
}

function assertRevision(context, namespace, revision) {
  if (revision === namespaceRevision(context, namespace)) return;
  throw domainError("STALE_ORDER", "This namespace changed since you opened Prioritize, so the order wasn't saved.", {
    resolution: "Refresh to load the current order, then make your changes again.",
  });
}

function assertRegistryWritable(config, registry) {
  if (config.error) throw domainError("INVALID_CHANGE", "docs/plans/plans-config.json cannot be read, so nothing can be saved.", { details: [config.error] });
  if (registry.state === "invalid") {
    throw domainError("INVALID_CHANGE", "docs/plans/plans-order.json cannot be read, so it was not overwritten.", {
      resolution: "Fix or remove the file, then try again.",
      details: [registry.error],
    });
  }
}

function assertWritable(context, namespace) {
  assertRegistryWritable(context.config, context.registry);
  if (!approvedNamespaces(context.config.namespaces).includes(namespace)) throw domainError("INVALID_CHANGE", `${namespace} is not an approved namespace.`);
  const ordering = namespaceOrdering(context, namespace);
  if (ordering.locked) throw domainError("INVALID_CHANGE", `The ${namespace} dependency graph needs repair before it can be ordered.`, { details: ordering.reasons });
  return ordering;
}

// Persists a proposal after checking it and the revision one last time. Only saveNamespaceOrder and
// placePlan call this. Other namespaces' entries, and entries this write cannot judge, stay as they
// are.
function applyOrder({ order, moves, findings, context, namespace }, expectedRevision) {
  if (findings.length) throw domainError("INVALID_CHANGE", findings[0].message, { details: findings.map((item) => item.message) });
  const fresh = orderingContext(context.root, context.records);
  assertRevision(fresh, namespace, expectedRevision);
  const preserved = (fresh.registry.namespaces[namespace] || []).filter((id) => {
    if (order.includes(id)) return false;
    const plan = fresh.plans.find((item) => item.id === id);
    return !plan || (plan.lifecycle === "backlog" && !plan.namespace);
  });
  const namespaces = { ...fresh.registry.namespaces };
  const entry = [...order, ...preserved];
  if (entry.length) namespaces[namespace] = entry;
  else delete namespaces[namespace];
  writeRegistry(context.root, namespaces, livePins(fresh.config, fresh.registry));
  return { order, moves, written: true, revision: namespaceRevision(orderingContext(context.root, context.records), namespace) };
}

// Every write goes through here. The rename is what makes it atomic: a reader sees the old file or
// the new one. `pinned` is left out when empty, so a repo that never pins keeps the plain file.
function writeRegistry(root, namespaces, pinned) {
  const file = path.join(root, PLANS_ORDER_RELATIVE_PATH);
  const temporary = path.join(path.dirname(file), `.plans-order.${process.pid}.tmp`);
  try {
    fs.writeFileSync(temporary, `${JSON.stringify({ schemaVersion: SCHEMA_VERSION, ...(pinned.length ? { pinned } : {}), namespaces }, null, 2)}\n`);
    fs.renameSync(temporary, file);
  } catch (err) {
    // A cleanup failure must not replace the error below, whose message is safe to show in the browser.
    try { fs.rmSync(temporary, { force: true }); } catch { /* the write failure is what gets reported */ }
    throw domainError("ORDER_WRITE_FAILED", `${PLANS_ORDER_RELATIVE_PATH} could not be written (${pathFreeFileError(err)}).`, {
      resolution: "Check that the file and its folder are writable, then save again.",
    });
  }
}
