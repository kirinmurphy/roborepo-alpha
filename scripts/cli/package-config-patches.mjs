// Declarative edits a package makes to one harness's root config. A `config-patch` resource names
// the harness and lists patches; the harness provider supplies only a generic editor for its config
// format (`configEdit.get/set/delete`), and this module owns what each patch means:
//
//   set    the value at `path` is ours. Applied only when the key is absent, already equal, or
//          recorded as ours; an unmanaged different value is left alone and reported. On removal
//          the recorded prior value comes back (or the key goes, if roborepo introduced it).
//   union  the items in `value` belong in the list at `path`. Added when missing, and only those
//          items are taken back out. With `delimiter`, the list is a delimited string ("path" means
//          the OS path-list separator).
//
// So a package owns its harness-specific settings as data, and adding a harness never means adding
// a method for one package's setting.

import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { rootConfigActive } from "./paths.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { clearOwnedScalar, readOwnedScalar, recordOwnedScalar } from "./owned-scalars-state.mjs";
import { expandPackageRuntimeRefs } from "./package-runtime-assets.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { requireHarnessCapability } from "../harnesses/harness-runtime.mjs";

export const CONFIG_EDIT_CAPABILITY = "config-edit";
const OPS = new Set(["set", "union"]);

function configEditor(harness) {
  const provider = getHarnessProvider(harness);
  requireHarnessCapability(provider, CONFIG_EDIT_CAPABILITY);
  return provider.adapters.configEdit;
}

function readText(filePath) {
  try { return fs.readFileSync(filePath, "utf8"); } catch { return ""; }
}

function describe(harness, patch) {
  return `${getHarnessProvider(harness).manifest.displayName} ${patch.path.join(".")}`;
}

// --- validation (package catalog) ----------------------------------------------------------

// Shape checks plus a trial write into an empty config, so a value the harness's format cannot
// hold (an object in TOML's place for a scalar, say) fails at `package validate`, not on enable.
export function normalizeConfigPatches(patches, harness, label) {
  if (!Array.isArray(patches) || patches.length === 0) throw new Error(`${label} needs a non-empty patches array`);
  const edit = configEditor(harness);
  return patches.map((patch, index) => {
    const where = `${label} patch ${index + 1}`;
    if (!patch || typeof patch !== "object") throw new Error(`${where} must be an object`);
    if (!OPS.has(patch.op)) throw new Error(`${where} op must be one of ${[...OPS].join(", ")}`);
    if (!Array.isArray(patch.path) || patch.path.length === 0 || !patch.path.every((key) => typeof key === "string" && key !== "")) {
      throw new Error(`${where} path must be a non-empty array of keys`);
    }
    if (patch.op === "set" && patch.value === undefined) throw new Error(`${where} set needs a value`);
    if (patch.op === "union") {
      if (!Array.isArray(patch.value) || patch.value.length === 0 || !patch.value.every((item) => typeof item === "string" && item !== "")) {
        throw new Error(`${where} union needs a non-empty array of strings`);
      }
      if (patch.delimiter !== undefined && (typeof patch.delimiter !== "string" || patch.delimiter === "")) {
        throw new Error(`${where} delimiter must be a non-empty string`);
      }
    } else if (patch.delimiter !== undefined) {
      throw new Error(`${where} delimiter only applies to union`);
    }
    try {
      edit.set("", patch.path, patch.op === "union" && patch.delimiter ? patch.value.join(",") : patch.value);
    } catch (err) {
      throw new Error(`${where}: ${err.message}`);
    }
    return { op: patch.op, path: [...patch.path], value: patch.value, ...(patch.delimiter ? { delimiter: patch.delimiter } : {}) };
  });
}

// Claim key for `set` patches, so two packages cannot both own one setting.
export function configPatchClaims(resource) {
  return resource.patches.filter((patch) => patch.op === "set").map((patch) => `${resource.harness}:${patch.path.join(".")}`);
}

// --- per-patch semantics ------------------------------------------------------------------

function resolvePatch(pkg, patch) {
  return {
    ...patch,
    value: expandPackageRuntimeRefs(patch.value, pkg),
    delimiter: patch.delimiter === "path" ? path.delimiter : patch.delimiter,
  };
}

function listItems(value, patch) {
  if (patch.delimiter) return typeof value === "string" ? value.split(patch.delimiter).filter(Boolean) : [];
  return Array.isArray(value) ? value : [];
}

// The list at `path`, or null when a value is there that is not a list of the patch's shape (or the
// editor could not parse it). Writing a list over such a value would destroy it.
function readList(edit, text, patch) {
  const current = readValue(edit, text, patch);
  if (!current.found) return [];
  if (current.unreadable) return null;
  const shaped = patch.delimiter ? typeof current.value === "string" : Array.isArray(current.value);
  return shaped ? listItems(current.value, patch) : null;
}

function warnUnreadable(harness, patch) {
  console.warn(`  conflict: ${describe(harness, patch)} holds a value RoboRepo cannot read or merge; leaving it unchanged`);
}

function listValue(items, patch) {
  return patch.delimiter ? items.join(patch.delimiter) : items;
}

function readValue(edit, text, patch) {
  try {
    return edit.get(text, patch.path);
  } catch (err) {
    return { found: true, value: undefined, unreadable: err.message };
  }
}

function applySet(edit, text, harness, patch, log) {
  const current = readValue(edit, text, patch);
  if (current.unreadable) {
    warnUnreadable(harness, patch);
    return text;
  }
  if (current.found && isDeepStrictEqual(current.value, patch.value)) {
    log(`  ok: ${describe(harness, patch)} already set`);
    return text;
  }
  const record = readOwnedScalar(harness, patch.path);
  if (current.found && !record) {
    console.warn(`  conflict: ${describe(harness, patch)} is unmanaged; leaving it unchanged`);
    return text;
  }
  if (!record) recordOwnedScalar(harness, patch.path, undefined);
  log(`  wired: ${describe(harness, patch)}`);
  return edit.set(text, patch.path, patch.value);
}

function removeSet(edit, text, harness, patch, log) {
  const current = readValue(edit, text, patch);
  if (current.unreadable) {
    warnUnreadable(harness, patch);
    return text;
  }
  const ours = current.found && isDeepStrictEqual(current.value, patch.value);
  const record = readOwnedScalar(harness, patch.path);
  if (record) clearOwnedScalar(harness, patch.path);
  if (current.found && !ours) {
    console.warn(`  conflict: ${describe(harness, patch)} ${record ? "changed since it was set" : "is unmanaged"}; leaving it unchanged`);
    return text;
  }
  if (!current.found) {
    log(`  ok: ${describe(harness, patch)} already absent`);
    return text;
  }
  log(`  removed: ${describe(harness, patch)}`);
  // No record means a value set before provenance was kept; it matches ours, so it goes.
  return record?.existed ? edit.set(text, patch.path, record.priorValue) : edit.delete(text, patch.path);
}

function applyUnion(edit, text, harness, patch, log) {
  const items = readList(edit, text, patch);
  if (!items) {
    warnUnreadable(harness, patch);
    return text;
  }
  const missing = patch.value.filter((item) => !items.includes(item));
  if (missing.length === 0) {
    log(`  ok: ${describe(harness, patch)} already includes ${patch.value.length} item(s)`);
    return text;
  }
  log(`  wired: ${missing.length} item(s) -> ${describe(harness, patch)}`);
  return edit.set(text, patch.path, listValue([...items, ...missing], patch));
}

function removeUnion(edit, text, harness, patch, log) {
  const items = readList(edit, text, patch);
  if (!items) {
    warnUnreadable(harness, patch);
    return text;
  }
  const owned = new Set(patch.value);
  const remaining = items.filter((item) => !owned.has(item));
  if (remaining.length === items.length) {
    log(`  ok: ${describe(harness, patch)} already excludes the package's items`);
    return text;
  }
  log(`  removed: ${items.length - remaining.length} item(s) <- ${describe(harness, patch)}`);
  return remaining.length ? edit.set(text, patch.path, listValue(remaining, patch)) : edit.delete(text, patch.path);
}

// Git reads exactly GIT_CONFIG_COUNT of the GIT_CONFIG_KEY_n / GIT_CONFIG_VALUE_n pairs in an
// environment group, and fails on a gap below the count. A package that adds or removes a pair
// therefore recounts them: the active pairs are those below the recorded count, plus every pair
// from index 0 up to the first index missing its key or its value (so an added pair is counted).
// When removal leaves a gap, the later active pairs move down to close it, and any ownership record
// moves with its pair; a user's pair after the package's stays read. The count is derived, like the
// baseline merge's, so it is never claimed as a package's own setting.
const GIT_CONFIG_PAIR = /^GIT_CONFIG_(KEY|VALUE)_\d+$/;

function reconcileGitConfigCounts(edit, text, harness, patches) {
  const groups = new Map();
  for (const patch of patches) {
    if (GIT_CONFIG_PAIR.test(patch.path.at(-1))) groups.set(JSON.stringify(patch.path.slice(0, -1)), patch.path.slice(0, -1));
  }
  for (const group of groups.values()) {
    const read = (name) => { try { return edit.get(text, [...group, name]); } catch { return { found: false }; } };
    const has = (name) => { const found = read(name); return found.found && typeof found.value === "string"; };
    // Candidate indices come from the text itself, so a large recorded count never drives the scan.
    const candidates = [...new Set([...text.matchAll(/GIT_CONFIG_KEY_(0|[1-9]\d*)\b/g)].map((match) => Number(match[1])))].sort((a, b) => a - b);
    const present = candidates.filter((i) => has(`GIT_CONFIG_KEY_${i}`) && has(`GIT_CONFIG_VALUE_${i}`));
    let run = 0;
    while (present.includes(run)) run += 1;
    const current = read("GIT_CONFIG_COUNT");
    const recorded = current.found && /^\d+$/.test(String(current.value)) ? Number(current.value) : 0;
    const active = present.filter((i) => i < Math.max(recorded, run));
    active.forEach((from, to) => {
      if (from === to) return;
      for (const kind of ["KEY", "VALUE"]) {
        const fromPath = [...group, `GIT_CONFIG_${kind}_${from}`];
        const toPath = [...group, `GIT_CONFIG_${kind}_${to}`];
        text = edit.delete(edit.set(text, toPath, read(`GIT_CONFIG_${kind}_${from}`).value), fromPath);
        const record = readOwnedScalar(harness, fromPath);
        clearOwnedScalar(harness, toPath);
        if (!record) continue;
        clearOwnedScalar(harness, fromPath);
        recordOwnedScalar(harness, toPath, record.existed ? record.priorValue : undefined);
      }
    });
    const count = active.length;
    if (current.found && current.value === String(count)) continue;
    if (!current.found && count === 0) continue;
    text = edit.set(text, [...group, "GIT_CONFIG_COUNT"], String(count));
  }
  return text;
}

const APPLY = { set: applySet, union: applyUnion };
const REMOVE = { set: removeSet, union: removeUnion };

// --- resource lifecycle -------------------------------------------------------------------

// `configPath` and `write` default to the harness's live root config and its tracked writer; tests
// point both at a sandbox.
function run(pkg, component, handlers, { configPath = rootConfigActive[component.harness], write, dryRun = false, log = console.log } = {}) {
  const edit = configEditor(component.harness);
  if (dryRun) {
    for (const patch of component.patches) console.log(`  [dry-run] ${handlers === APPLY ? "apply" : "remove"} ${patch.op} ${describe(component.harness, patch)}`);
    return;
  }
  const before = readText(configPath);
  let text = before;
  for (const patch of component.patches) {
    const resolved = resolvePatch(pkg, patch);
    text = handlers[resolved.op](edit, text, component.harness, resolved, log);
  }
  text = reconcileGitConfigCounts(edit, text, component.harness, component.patches);
  if (text === before) return;
  if (write) write(text);
  else writeRootConfig(component.harness, configPath, text);
}

export function applyConfigPatches(pkg, component, options) {
  run(pkg, component, APPLY, options);
}

export function removeConfigPatches(pkg, component, options) {
  run(pkg, component, REMOVE, options);
}

// { observed, owner, detail } for package status. A `set` patch whose key holds a different value
// is someone else's setting, which the detail says rather than calling it merely missing.
export function probeConfigPatches(pkg, component, { configPath = rootConfigActive[component.harness] } = {}) {
  const edit = configEditor(component.harness);
  const text = readText(configPath);
  let applied = 0;
  let foreign = false;
  for (const patch of component.patches.map((entry) => resolvePatch(pkg, entry))) {
    const current = readValue(edit, text, patch);
    if (patch.op === "set") {
      if (current.found && isDeepStrictEqual(current.value, patch.value)) applied += 1;
      else if (current.found) foreign = true;
    } else if (patch.value.every((item) => listItems(current.value, patch).includes(item))) {
      applied += 1;
    }
  }
  const total = component.patches.length;
  const observed = applied === total;
  const name = component.label || "settings";
  return {
    observed,
    owner: observed ? "roborepo" : foreign ? "external" : null,
    detail: observed
      ? `${name} applied (${total} setting(s))`
      : foreign ? `${name} set to a different value outside RoboRepo` : `${name} missing ${total - applied} of ${total} setting(s)`,
  };
}
