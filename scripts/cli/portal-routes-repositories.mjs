// /api/repositories* routes — the canonical repository API surface. Read-only summaries
// are separated from mutations; mutations (POST/PATCH) rely on portal-server.mjs's existing
// loopback-origin + token guard exactly like the other domains.
//
// Repository ids contain ':' and '/', so in the path they are percent-encoded; portal-router.mjs's
// :id segment decodes them. Every payload is path-free by construction (see modules/repositories/summary.mjs)
// except the /api/repositories/sources* management routes, the one surface allowed to carry
// configured source paths. Those routes are listed before /api/repositories/:id so the
// literal `sources` segment is never read as a repository id.
import { send, readJsonBody } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";

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
  postRoute("/api/repositories/:id/worktrees/remove-preview", (handlers, body, params) => handlers.previewRepositoryWorktree({ repositoryId: params.id, branch: body.branch })),
  postRoute("/api/repositories/:id/worktrees/remove", (handlers, body, params) => handlers.removeRepositoryWorktree({ repositoryId: params.id, branch: body.branch, receipt: body.receipt })),
  postRoute("/api/repositories/:id/worktrees/stop-servers", (handlers, body, params) => handlers.stopRepositoryWorktreeServers({ repositoryId: params.id, branch: body.branch })),
  postRoute("/api/repositories/:id/worktree-cleanup/enable", (handlers, body, params) => handlers.enableWorktreeCleanup({ repositoryId: params.id, folder: body.folder })),
  postRoute("/api/repositories/:id/worktree-cleanup/dismiss", (handlers, body, params) => handlers.dismissWorktreeCleanupNotice({ repositoryId: params.id })),
  // Branch protection reads GitHub, so both routes answer asynchronously. The POST runs one action
  // (protect, skip, or unskip) and writes only RoboRepo-managed rulesets.
  {
    method: "GET",
    path: "/api/repositories/:id/protection",
    handler: (req, res, { params, handlers }) => {
      handlers.loadRepositoryProtection({ repositoryId: params.id }).then(
        (result) => send(res, 200, "application/json", JSON.stringify(result)),
        (err) => sendError(res, err),
      );
      return true;
    },
  },
  postRoute("/api/repositories/:id/protection", (handlers, body, params) => handlers.applyRepositoryProtection({ repositoryId: params.id, action: body.action })),
  // The GitHub bot identity. The GET only reads status (`?fresh=1` skips the server's five-minute
  // cache); the POST opens `roborepo github setup` in a terminal and takes no body, because the
  // command, its arguments, and its folder are the server's choice alone. The token is typed in
  // that terminal, never sent here.
  // The bot account, shared by every repo (the Home banner), and turning the package on when that
  // is the one step left. The POST takes no body: the server decides from a fresh read.
  {
    method: "GET",
    path: "/api/agent-identity",
    handler: (req, res, { qs, handlers }) => {
      const fresh = new URLSearchParams(qs).get("fresh") === "1";
      Promise.resolve()
        .then(() => handlers.loadAgentIdentityAccount({ fresh }))
        .then((result) => send(res, 200, "application/json", JSON.stringify(result)), (err) => sendError(res, err));
      return true;
    },
  },
  {
    method: "POST",
    path: "/api/agent-identity/enable",
    handler: (req, res, { handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)) {
          return send(res, 400, "application/json", JSON.stringify({ error: "expected an empty body" }));
        }
        Promise.resolve()
          .then(() => handlers.turnOnAgentIdentity())
          .then((result) => send(res, 200, "application/json", JSON.stringify(result)), (error) => sendError(res, error));
      });
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/repositories/:id/agent-identity",
    handler: (req, res, { params, qs, handlers }) => {
      const fresh = new URLSearchParams(qs).get("fresh") === "1";
      Promise.resolve()
        .then(() => handlers.loadRepositoryAgentIdentity({ repositoryId: params.id, fresh }))
        .then((result) => send(res, 200, "application/json", JSON.stringify(result)), (err) => sendError(res, err));
      return true;
    },
  },
  {
    method: "POST",
    path: "/api/repositories/:id/agent-identity/setup",
    handler: (req, res, { params, handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)) {
          return send(res, 400, "application/json", JSON.stringify({ error: "expected an empty body" }));
        }
        Promise.resolve()
          .then(() => handlers.launchAgentIdentitySetup({ repositoryId: params.id }))
          .then((result) => send(res, 200, "application/json", JSON.stringify(result)), (error) => sendError(res, error));
      });
      return true;
    },
  },
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

function writeResult(res, fn) {
  try {
    send(res, 200, "application/json", JSON.stringify(fn()));
  } catch (err) {
    sendError(res, err);
  }
}

function sendError(res, err) {
  const status = err?.code === "NOT_FOUND" ? 404 : 400;
  send(res, status, "application/json", JSON.stringify({ error: String(err?.message || err) }));
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
        const success = (result) => {
          send(res, 200, "application/json", JSON.stringify(result));
        };
        const failure = (error) => {
          const status = error?.code === "NOT_FOUND" ? 404 : 400;
          send(res, status, "application/json", JSON.stringify({ error: { code: error?.code || "INVALID_SOURCE", message: String(error?.message || error) } }));
        };
        try {
          const result = run(handlers, body || {}, params);
          if (result && typeof result.then === "function") result.then(success, failure);
          else success(result);
        } catch (error) { failure(error); }
      });
      return true;
    },
  };
}
