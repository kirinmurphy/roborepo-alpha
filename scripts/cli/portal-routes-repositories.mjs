// /api/repositories* routes — the canonical repository API surface. Read-only summaries
// are separated from mutations; mutations (POST/PATCH) rely on portal-server.mjs's existing
// loopback-origin + token guard exactly like the other domains.
//
// Repository ids contain ':' and '/', so in the path they are percent-encoded; portal-router.mjs's
// :id segment decodes them. Every payload is path-free by construction (see modules/repositories/summary.mjs)
// except the /api/repositories/sources* management routes, the one surface allowed to carry
// configured source paths (pljvmyh §6). Those routes are listed before /api/repositories/:id so the
// literal `sources` segment is never read as a repository id.
import { send, readJsonBody } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";

function writeResult(res, fn) {
  try {
    send(res, 200, "application/json", JSON.stringify(fn()));
  } catch (err) {
    const status = err?.code === "NOT_FOUND" ? 404 : 400;
    send(res, status, "application/json", JSON.stringify({ error: String(err?.message || err) }));
  }
}

// Source mutations answer with the structured { error: { code, message } } shape portalPostJson
// preserves, because the dialog branches on codes such as INTENT_REQUIRED and DUPLICATE_SOURCE.
function postRoute(path, run) {
  return {
    method: "POST",
    path,
    handler: (req, res, { params, handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        try {
          send(res, 200, "application/json", JSON.stringify(run(handlers, body || {}, params)));
        } catch (error) {
          const status = error?.code === "NOT_FOUND" ? 404 : 400;
          send(res, status, "application/json", JSON.stringify({ error: { code: error?.code || "INVALID_SOURCE", message: String(error?.message || error) } }));
        }
      });
      return true;
    },
  };
}

export const repositoriesRoutes = defineRoutes([
  {
    method: "GET",
    path: "/api/home",
    handler: (req, res, { handlers }) => {
      writeResult(res, () => handlers.loadHomeOverview());
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/repositories/:urlKey/overview",
    handler: (req, res, { params, handlers }) => {
      writeResult(res, () => handlers.loadRepositoryOverview({ urlKey: params.urlKey }));
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/repositories/sources",
    handler: (req, res, { handlers }) => {
      writeResult(res, () => handlers.loadRepositorySources());
      return true;
    },
  },
  postRoute("/api/repositories/sources", (handlers, body) => handlers.addRepositorySource({ path: body.path, kind: body.kind || null })),
  postRoute("/api/repositories/sources/refresh", (handlers, body) => handlers.refreshRepositorySources({ id: body.id || null })),
  postRoute("/api/repositories/sources/wipe", (handlers) => handlers.wipeRepositoryList()),
  postRoute("/api/repositories/sources/:sourceId/enabled", (handlers, body, params) => handlers.setRepositorySourceEnabled({ id: params.sourceId, enabled: body.enabled })),
  postRoute("/api/repositories/sources/:sourceId/remove", (handlers, body, params) => handlers.removeRepositorySource({ id: params.sourceId })),
  {
    method: "GET",
    path: "/api/repositories",
    handler: (req, res, { handlers }) => {
      send(res, 200, "application/json", JSON.stringify(handlers.loadRepositories()));
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/repositories/:id/associations",
    handler: (req, res, { params, handlers }) => {
      writeResult(res, () => handlers.loadRepositoryAssociations({ repositoryId: params.id }));
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/repositories/:id",
    handler: (req, res, { params, handlers }) => {
      writeResult(res, () => handlers.loadRepository({ repositoryId: params.id }));
      return true;
    },
  },
  {
    method: "PATCH",
    path: "/api/repositories/:id",
    handler: (req, res, { params, handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        writeResult(res, () => handlers.patchRepository({ repositoryId: params.id, visibility: (body || {}).visibility }));
      });
      return true;
    },
  },
]);
