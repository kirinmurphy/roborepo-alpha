#!/usr/bin/env node
// The shared Portal repository scope (`?repo=<urlKey>`): how a key resolves, how the Plans
// and Tokens data routes answer for each kind of key, how a Plans snapshot narrows, and the browser
// helpers that compose scope URLs and selector choices. The served-portal behavior (cache keys,
// Activity outside listed repos over a real spool) is in repository-scope-portal-check.mjs.
import assert from "node:assert/strict";
import {
  defaultRegistry, hideRepository, listedRepositoryIds, resolveRepositoryScope, upsertRepository,
} from "../../modules/repositories/index.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import { plansRoutes } from "../cli/portal-routes-plans.mjs";
import { telemetryRoutes } from "../cli/portal-routes-telemetry.mjs";
import { scopeSnapshot } from "../cli/plans.mjs";
import { hrefWithRepositoryScope, scopedPagePath } from "../../portal/shared/repository-scope.js";
import { repositoryScopeChoices, resolveScopeChoice } from "../../portal/shared/repository-scope-choices.js";

const ALPHA = "git:github.com/acme/alpha";
const BETA = "git:github.com/other/alpha";
const HIDDEN = "git:github.com/acme/ignored";
const registry = defaultRegistry();
upsertRepository(registry, { id: ALPHA, kind: "git", displayName: "alpha", providerUrl: "https://github.com/acme/alpha" });
upsertRepository(registry, { id: BETA, kind: "git", displayName: "alpha", providerUrl: "https://github.com/other/alpha" });
upsertRepository(registry, { id: HIDDEN, kind: "git", displayName: "ignored" });
hideRepository(registry, HIDDEN, { hidden: true });
const alphaKey = registry.repositories[ALPHA].urlKey;
const betaKey = registry.repositories[BETA].urlKey;
const hiddenKey = registry.repositories[HIDDEN].urlKey;

// ---- Resolution: unavailable is its own answer, never "all" and never a throw ----
assert.deepEqual(resolveRepositoryScope(registry, null), { kind: "all" });
assert.deepEqual(resolveRepositoryScope(registry, ""), { kind: "all" });
assert.deepEqual(resolveRepositoryScope(registry, alphaKey), { kind: "repository", repositoryId: ALPHA });
assert.deepEqual(resolveRepositoryScope(registry, betaKey), { kind: "repository", repositoryId: BETA });
for (const value of ["nope", hiddenKey, "Bad Key", "../etc", ALPHA, "_other"]) {
  assert.deepEqual(resolveRepositoryScope(registry, value), { kind: "unavailable" }, `${value} is unavailable`);
}
assert.deepEqual(resolveRepositoryScope(registry, "_other", { allowOutside: true }), { kind: "outside" });
assert.deepEqual(listedRepositoryIds(registry).sort(), [ALPHA, BETA].sort(), "hidden repositories are not listed");

// ---- Routes: scoped data for a valid key, an explicit 404 status otherwise ----
const handlers = {
  resolveRepositoryScope: (value, options) => resolveRepositoryScope(registry, value, options),
  loadPlans: (params) => ({ scopedTo: params.repositoryId }),
  refreshPlans: (params) => ({ refreshedFor: params.repositoryId }),
  loadAnalysisJson: (window, harness, extra) => JSON.stringify({ scope: extra.scope, extraKeys: Object.keys(extra).sort() }),
};
function request(routes, urlPath, qs, method = "GET") {
  const res = { statusCode: null, body: null, writeHead(code) { this.statusCode = code; }, end(body) { this.body = body; } };
  assert.equal(dispatchRoutes([routes], { method }, res, urlPath, qs, handlers), true, `${urlPath}?${qs} is routed`);
  return { status: res.statusCode, json: JSON.parse(res.body) };
}
const UNAVAILABLE = { status: 404, code: "REPOSITORY_SCOPE_UNAVAILABLE" };
const unavailable = (response) => ({ status: response.status, code: response.json.error?.code });

assert.deepEqual(request(plansRoutes, "/api/plans", "").json, { scopedTo: null });
assert.deepEqual(request(plansRoutes, "/api/plans", `repo=${alphaKey}`).json, { scopedTo: ALPHA });
assert.deepEqual(request(plansRoutes, "/api/plans/refresh", `repo=${betaKey}`, "POST").json, { refreshedFor: BETA });
for (const value of ["nope", hiddenKey, "Bad%20Key", "_other", encodeURIComponent(ALPHA)]) {
  assert.deepEqual(unavailable(request(plansRoutes, "/api/plans", `repo=${value}`)), UNAVAILABLE, `/api/plans?repo=${value}`);
}

assert.deepEqual(request(telemetryRoutes, "/api/data", "").json.scope, { kind: "all" });
assert.deepEqual(request(telemetryRoutes, "/api/data", `repo=${alphaKey}`).json.scope, { kind: "repository", repositoryId: ALPHA });
assert.deepEqual(request(telemetryRoutes, "/api/data", "repo=_other").json.scope, { kind: "outside" });
// Only a urlKey names a repo: a canonical id is unavailable, and the former ?repository= spelling is
// not a parameter at all.
assert.deepEqual(unavailable(request(telemetryRoutes, "/api/data", `repo=${encodeURIComponent(ALPHA)}`)), UNAVAILABLE);
for (const value of ["nope", hiddenKey, "Bad%20Key"]) {
  assert.deepEqual(unavailable(request(telemetryRoutes, "/api/data", `repo=${value}`)), UNAVAILABLE, `/api/data?repo=${value}`);
}
const formerSpelling = request(telemetryRoutes, "/api/data", `repository=${alphaKey}`).json;
assert.deepEqual(formerSpelling.scope, { kind: "all" }, "?repository= is ignored");
assert.deepEqual(formerSpelling.extraKeys, ["markerId", "model", "scope"], "no repo label reaches the analysis");

// ---- Plans snapshot: one repository's plans, scan state, and errors ----
const snapshot = {
  plans: [{ key: "a1", repository: { repositoryId: ALPHA } }, { key: "b1", repository: { repositoryId: BETA } }],
  repositories: [{ repositoryId: ALPHA }, { repositoryId: BETA }],
  repositoryScans: [{ repositoryId: ALPHA, state: "scanned" }, { repositoryId: BETA, state: "scanned" }],
  errors: [{ repositoryId: BETA, error: "scan failed" }],
};
assert.equal(scopeSnapshot(snapshot, null), snapshot, "no scope returns the cached snapshot unchanged");
const alphaOnly = scopeSnapshot(snapshot, ALPHA);
assert.deepEqual(alphaOnly.plans.map((plan) => plan.key), ["a1"]);
assert.deepEqual(alphaOnly.repositories, [{ repositoryId: ALPHA }]);
assert.deepEqual(alphaOnly.repositoryScans, [{ repositoryId: ALPHA, state: "scanned" }]);
assert.deepEqual(alphaOnly.errors, []);
// A repository Plans never scanned (no recorded checkout) reads as not scanned, not as "no
// repositories known".
assert.deepEqual(scopeSnapshot(snapshot, HIDDEN).repositoryScans, [{ repositoryId: HIDDEN, state: "unavailable", planCount: 0, checkoutCount: 0 }]);

// ---- Browser helpers: scope URLs and nav composition ----
assert.equal(hrefWithRepositoryScope("/plans?lifecycle=backlog#top", "alpha"), "/plans?lifecycle=backlog&repo=alpha#top");
assert.equal(hrefWithRepositoryScope("/plans?repo=alpha&lifecycle=backlog", null), "/plans?lifecycle=backlog", "clearing keeps page parameters");
const page = (path, flags = {}) => ({ path, ...flags });
assert.equal(scopedPagePath(page("/tokens", { repositoryScope: true }), "alpha"), "/tokens?repo=alpha");
assert.equal(scopedPagePath(page("/runtime"), "alpha"), "/runtime", "unscoped pages drop the scope");
assert.equal(scopedPagePath(page("/"), "alpha"), "/");
assert.equal(scopedPagePath(page("/plans", { repositoryScope: true }), "_other"), "/plans", "outside activity stays on Tokens");
assert.equal(scopedPagePath(page("/tokens", { repositoryScope: true, outsideActivityScope: true }), "_other"), "/tokens?repo=_other");
assert.equal(scopedPagePath(page("/plans", { repositoryScope: true }), null), "/plans");

// ---- Selector choices: collisions told apart by owner, then urlKey; never a path ----
const summaries = [
  { urlKey: "alpha", displayName: "alpha", providerUrl: "https://github.com/acme/alpha" },
  { urlKey: "alpha-x1", displayName: "alpha", providerUrl: "https://github.com/other/alpha" },
  { urlKey: "alpha-local", displayName: "alpha", providerUrl: null },
  { urlKey: "beta", displayName: "beta", providerUrl: null },
];
assert.deepEqual(repositoryScopeChoices(summaries), [
  ["", "All repos"],
  ["alpha", "alpha (acme)"],
  ["alpha-local", "alpha (alpha-local)"],
  ["alpha-x1", "alpha (other)"],
  ["beta", "beta"],
]);
assert.deepEqual(repositoryScopeChoices(summaries, { outsideActivity: true }).at(-1), ["_other", "Activity outside listed repos"]);
assert.equal(JSON.stringify(repositoryScopeChoices(summaries)).includes("/Users/"), false);
assert.deepEqual(resolveScopeChoice(null, summaries), { status: "all" });
assert.equal(resolveScopeChoice("beta", summaries).status, "repository");
assert.equal(resolveScopeChoice("gone", summaries).status, "unavailable");
assert.equal(resolveScopeChoice("_other", summaries).status, "unavailable", "outside activity is Tokens-only");
assert.equal(resolveScopeChoice("_other", summaries, { outsideActivity: true }).status, "outside");

console.log("repository scope checks passed");
