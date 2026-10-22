// Hook readiness: whether the hooks RoboRepo expects in a harness will actually run there. The
// expected set comes from the harness's core hooks plus enabled packages' `hooks` resources; the
// observed set comes from the provider's hooks.read, which alone knows the harness's trust rules.
// Package status, the portal route, and doctor all consume this, so it sits with the shared harness
// code and takes already-loaded inputs (packages, paths) instead of importing the CLI layer.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { getHarnessProvider } from "./registry.mjs";
import { isStubAdapter } from "./stub-adapter.mjs";

// Worst first: a harness or group reports the first state any of its hooks is in.
export const READINESS_STATES = Object.freeze(["missing", "review_required", "inactive", "unknown", "active"]);

const ACTIVE_TRUST = new Set(["trusted", "managed", "not-required"]);
const REVIEW_TRUST = new Set(["untrusted", "modified"]);

// A harness whose hooks.read is still a placeholder (Gemini) has no readiness to report.
export function readinessSupported(harness) {
  return !isStubAdapter(getHarnessProvider(harness).adapters.hooks?.read);
}

// One { event, command } per handler in a hooks fragment; `_`-prefixed keys are comments.
export function fragmentHooks(fragment) {
  return Object.entries(fragment || {})
    .filter(([event, groups]) => !event.startsWith("_") && Array.isArray(groups))
    .flatMap(([event, groups]) => groups.flatMap((group) => (group.hooks || [])
      .filter((hook) => hook.command)
      .map((hook) => ({
        event, command: hook.command,
        ...(hook.statusMessage ? { name: hook.statusMessage } : {}),
        ...(fragment._descriptions?.[hook.statusMessage] ? { description: fragment._descriptions[hook.statusMessage] } : {}),
      }))));
}

// Hook resources name exactly one harness each, the same field packages.mjs installs them by, and
// their `source` is repo-relative there too. `includeCore` is false when the user has not chosen to
// install the harness's core hooks, so their absence is not reported as missing.
export function expectedHooks(harness, { packages = [], repoRoot, includeCore = true }) {
  const provider = getHarnessProvider(harness);
  const core = provider.adapters.hooks?.core;
  const groups = [];
  if (includeCore && typeof core === "function") {
    groups.push({ owner: "core", label: `${provider.manifest.displayName} core hooks`, hooks: fragmentHooks(core()) });
  }
  for (const pkg of packages) {
    const hooks = (pkg.components || [])
      .filter((component) => component.type === "hooks" && component.harness === harness)
      .flatMap((component) => fragmentHooks(readFragment(path.join(repoRoot, component.source))));
    groups.push({ owner: pkg.id, label: pkg.label || pkg.id, hooks });
  }
  return groups.filter((group) => group.hooks.length > 0);
}

// Pure comparison of expected groups against hooks.read records. Records from another source file
// (a project or plugin hook that happens to share a command) never satisfy an expected hook.
//
// `reviewRevision` names the exact set of RoboRepo hooks awaiting review, so a surface can offer
// review once per set: it changes when a definition changes or a trust key shifts, and stays the
// same across repeated reads of the same pending hooks. It is a digest of the records' opaque
// `identity` (or their event, command, and trust when a provider supplies none), never trust
// material itself. Null when nothing awaits review.
export function compareHookReadiness(expectedGroups, observed, { hooksPath = null } = {}) {
  const inScope = (observed || []).filter((record) => !hooksPath || !record.sourcePath || samePath(record.sourcePath, hooksPath));
  const pending = [];
  const groups = expectedGroups.map((group) => {
    const hooks = group.hooks.map((hook) => {
      const record = inScope.find((entry) => entry.event === hook.event && entry.command === hook.command);
      const state = hookState(record);
      if (state === "review_required") pending.push(record.identity ?? `${record.event}\t${record.command}\t${record.trust}`);
      return { ...hook, trust: record?.trust ?? null, enabled: record?.enabled ?? null, state };
    });
    return { owner: group.owner, label: group.label, state: worstState(hooks), hooks };
  });
  return { state: worstState(groups), groups, reviewRevision: digest(pending) };
}

// hooks.read for one harness, compared with what RoboRepo expects there.
export async function readHookReadiness(harness, { packages, repoRoot, hooksPath, cwd, includeCore = true, readOptions = {} }) {
  const provider = getHarnessProvider(harness);
  if (!readinessSupported(harness)) return { harness, displayName: provider.manifest.displayName, supported: false, state: null, groups: [] };
  const observed = await provider.adapters.hooks.read({ cwd, hooksPath, ...readOptions });
  const result = compareHookReadiness(expectedHooks(harness, { packages, repoRoot, includeCore }), observed, { hooksPath });
  return { harness, displayName: provider.manifest.displayName, supported: true, ...result };
}

function hookState(record) {
  if (!record) return "missing";
  if (REVIEW_TRUST.has(record.trust)) return "review_required";
  if (record.enabled === false) return "inactive";
  if (ACTIVE_TRUST.has(record.trust)) return "active";
  return "unknown";
}

function worstState(items) {
  if (items.length === 0) return "active";
  return READINESS_STATES.find((state) => items.some((item) => item.state === state)) ?? "unknown";
}

function digest(identities) {
  if (identities.length === 0) return null;
  return crypto.createHash("sha256").update([...new Set(identities)].sort().join("\n")).digest("hex").slice(0, 16);
}

function samePath(a, b) {
  return path.resolve(a) === path.resolve(b);
}

function readFragment(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return {}; }
}
