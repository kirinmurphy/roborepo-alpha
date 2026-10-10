#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repositoriesRoutes } from "../cli/portal-routes-repositories.mjs";
import { dispatchRoutes } from "../cli/portal-router.mjs";
import {
  loadRepositoriesPayload, loadRepositoryPayload, loadRepositoryPayloadByUrlKey, loadRepositoryAssociations, patchRepository,
} from "../cli/repositories.mjs";
import { recordRepositoryDiscovery } from "../cli/repositories.mjs";
import { addRepositorySource, loadRepositorySources } from "../cli/repository-sources.mjs";
import { repositorySummary, repositoryDetailPayload } from "../../modules/repositories/index.mjs";
import { fakeResponse } from "./lib/fake-response.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-repo-api-"));
const stateRoot = path.join(tempRoot, "state");

function get(urlPath, handlers) {
  const res = fakeResponse();
  const matched = dispatchRoutes([repositoriesRoutes], { method: "GET" }, res, urlPath, "", handlers);
  return { matched, res };
}

try {
  const id = "git:github.com/kirinmurphy/roborepo";
  recordRepositoryDiscovery({ repositoryId: id, kind: "git", displayName: "roborepo", source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: "rootaaaa1111", stateRoot });
  recordRepositoryDiscovery({ repositoryId: id, kind: "git", displayName: "roborepo", source: "plans", evidence: "configured-scan-root", confidence: "high", stateRoot });

  // ---- Summary shape is browser-safe: no absolute paths, no root, no raw config ----
  const listPayload = loadRepositoriesPayload({ stateRoot });
  assert.equal(listPayload.repositories.length, 1);
  const summary = listPayload.repositories[0];
  const json = JSON.stringify(summary);
  assert.ok(!json.includes(tempRoot), "summary must not leak the temp/local path");
  assert.ok(!/\/(Users|home|tmp|var|private)\//.test(json), "summary must not contain a filesystem path");
  assert.ok(!("root" in summary) && !("localRoots" in summary), "summary carries no root field");
  assert.equal(summary.repositoryId, id);
  assert.equal(summary.urlKey, "roborepo");
  assert.equal(summary.pinned, false);
  assert.equal(summary.providerUrl, "https://github.com/kirinmurphy/roborepo");
  assert.deepEqual([...summary.discoveredBy].sort(), ["developer-runtime", "plans"]);
  assert.equal(summary.capabilities.developerRuntime, true);
  assert.equal(summary.capabilities.plans, true);
  assert.equal(summary.capabilities.telemetry, false);
  assert.equal(summary.enrollments.plans, undefined, "capabilities != enrollments");

  // Detail exposes local-root kinds/counts but still no absolute path.
  const detail = loadRepositoryPayload({ repositoryId: id, stateRoot });
  const detailJson = JSON.stringify(detail);
  assert.ok(!detailJson.includes(tempRoot), "detail must not leak paths");
  assert.equal(detail.localRoots.length, 1);
  assert.equal(detail.localRoots[0].kind, "primary");
  assert.ok(!("rootId" in detail.localRoots[0]), "detail localRoots expose kind/timestamps, not the opaque rootId");
  assert.equal(loadRepositoryPayloadByUrlKey({ urlKey: "roborepo", stateRoot }).repositoryId, id);

  // ---- Route handler dispatch ----
  const handlers = {
    loadRepositories: () => loadRepositoriesPayload({ stateRoot }),
    loadRepository: (p) => loadRepositoryPayload({ ...p, stateRoot }),
    loadRepositoryAssociations: (p) => loadRepositoryAssociations({ ...p, stateRoot }),
    patchRepository: (p) => patchRepository({ ...p, stateRoot }),
    loadHomeOverview: () => ({ repositories: [{ repositoryId: id }] }),
    loadRepositoryOverview: ({ urlKey }) => urlKey === "roborepo"
      ? { repository: loadRepositoryPayloadByUrlKey({ urlKey, stateRoot }) }
      : (() => { const error = new Error("unknown repository"); error.code = "NOT_FOUND"; throw error; })(),
  };

  const home = get("/api/home", handlers);
  assert.equal(home.res.statusCode, 200);
  assert.equal(JSON.parse(home.res.body).repositories.length, 1);

  const overview = get("/api/repositories/roborepo/overview", handlers);
  assert.equal(overview.res.statusCode, 200);
  assert.equal(JSON.parse(overview.res.body).repository.urlKey, "roborepo");
  const missingOverview = get("/api/repositories/missing/overview", handlers);
  assert.equal(missingOverview.res.statusCode, 404);
  assert.equal(dispatchRoutes([repositoriesRoutes], { method: "GET" }, fakeResponse(), "/api/repositories/%E0%A4%A/overview", "", handlers), false, "malformed urlKey encoding does not match a route");

  const list = get("/api/repositories", handlers);
  assert.equal(list.matched, true);
  assert.equal(list.res.statusCode, 200);
  assert.equal(JSON.parse(list.res.body).repositories.length, 1);

  const encoded = encodeURIComponent(id);
  const one = get(`/api/repositories/${encoded}`, handlers);
  assert.equal(one.res.statusCode, 200);
  assert.equal(JSON.parse(one.res.body).repositoryId, id);

  // ---- Hidden repos are omitted from the ordinary list, but counted ----
  patchRepository({ repositoryId: id, visibility: "hidden", stateRoot });
  const afterHide = loadRepositoriesPayload({ stateRoot });
  assert.equal(afterHide.repositories.length, 0, "hidden repo omitted from ordinary list");
  assert.equal(afterHide.hiddenCount, 1, "hidden repo still counted");
  const withHidden = loadRepositoriesPayload({ stateRoot, includeHidden: true });
  assert.equal(withHidden.repositories.length, 1, "includeHidden surfaces it");
  patchRepository({ repositoryId: id, visibility: "visible", stateRoot }); // restore for later asserts

  const assoc = get(`/api/repositories/${encoded}/associations`, handlers);
  assert.equal(assoc.res.statusCode, 200);
  assert.equal(JSON.parse(assoc.res.body).discoveries.length, 2);

  const missing = get(`/api/repositories/${encodeURIComponent("git:github.com/x/y")}`, handlers);
  assert.equal(missing.res.statusCode, 404, "unknown repository -> 404");

  // Non-repositories path is not matched (lets route() fall through).
  assert.equal(dispatchRoutes([repositoriesRoutes], { method: "GET" }, fakeResponse(), "/api/plans", "", handlers), false);

  // ---- PATCH visibility via handler (POST/PATCH body path) ----
  const res = fakeResponse();
  const req = patchReq({ visibility: "hidden" });
  dispatchRoutes([repositoriesRoutes], req, res, `/api/repositories/${encoded}`, "", handlers);
  // readJsonBody consumes the request async; flush the mock's data/end below.
  req._emit();
  assert.equal(res.statusCode, 200);
  assert.equal(JSON.parse(res.body).visibility, "hidden");

  // ---- Source-management routes ----
  const sourceHandlers = {
    ...handlers,
    loadRepositorySources: () => loadRepositorySources({ stateRoot, homeDir: tempRoot }),
    addRepositorySource: (p) => addRepositorySource({ ...p, stateRoot, homeDir: tempRoot }),
  };
  const sources = get("/api/repositories/sources", sourceHandlers);
  assert.equal(sources.res.statusCode, 200, "the literal sources segment is not read as a repository id");
  assert.equal(JSON.parse(sources.res.body).autoDiscovery.enabled, false);
  const addRes = fakeResponse();
  const addReq = patchReq({ path: path.join(tempRoot, "missing-folder") });
  addReq.method = "POST";
  dispatchRoutes([repositoriesRoutes], addReq, addRes, "/api/repositories/sources", "", sourceHandlers);
  addReq._emit();
  assert.equal(addRes.statusCode, 400);
  assert.deepEqual(JSON.parse(addRes.body).error.code, "INTENT_REQUIRED", "source errors are structured so the dialog can branch on the code");

  console.log("repositories-api-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}

// Mock a PATCH request whose body is delivered when _emit() is called (readJsonBody uses on(data)/on(end)).
function patchReq(bodyObj) {
  const listeners = {};
  return {
    method: "PATCH",
    headers: {},
    on(event, cb) { listeners[event] = cb; return this; },
    _emit() {
      if (listeners.data) listeners.data(Buffer.from(JSON.stringify(bodyObj)));
      if (listeners.end) listeners.end();
    },
  };
}
