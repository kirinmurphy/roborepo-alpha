// /api/plans* routes — the Plans page's API surface. handlers is the object startPortalServer()
// was given (loadPlans, loadPlanDocument, buildPlansPrompt, refreshPlans come
// from telemetry.mjs's wiring).
import { send, readJsonBody } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";
import { readRepositoryScope } from "./portal-routes-scope.mjs";

export const plansRoutes = defineRoutes([
  {
    // ?repo=<urlKey> narrows the snapshot to one repository (the shared Portal scope).
    path: "/api/plans",
    handler: (req, res, { qs, handlers }) => {
      const scope = readRepositoryScope(new URLSearchParams(qs), res, handlers);
      if (!scope) return true;
      send(res, 200, "application/json", JSON.stringify(handlers.loadPlans({ repositoryId: scope.repositoryId ?? null })));
      return true;
    },
  },
  {
    path: "/api/plans/document",
    handler: (req, res, { qs, handlers }) => {
      const params = new URLSearchParams(qs);
      try {
        send(res, 200, "application/json", JSON.stringify(handlers.loadPlanDocument({ key: params.get("key") })));
      } catch (err) {
        send(res, 400, "application/json", JSON.stringify({ error: String(err?.message || err) }));
      }
      return true;
    },
  },
  postJsonRoute("/api/plans/prompt", (handlers, body) => handlers.buildPlansPrompt(body)),
  postJsonRoute("/api/plans/priority", (handlers, body) => handlers.updatePlanPriority(body), { domainError: true }),
  {
    method: "POST",
    path: "/api/plans/refresh",
    handler: (req, res, { qs, handlers }) => {
      const scope = readRepositoryScope(new URLSearchParams(qs), res, handlers);
      if (!scope) return true;
      send(res, 200, "application/json", JSON.stringify(handlers.refreshPlans({ repositoryId: scope.repositoryId ?? null })));
      return true;
    },
  },
]);

// Serializes a domain error (see modules/plan-suite/index.mjs's domainError helper) into the
// structured { error: { code, message, resolution, details } } shape the client's portalPostJson
// preserves. Falls back to a plain 400 for any error that isn't domain-shaped (shouldn't happen
// once every plan-suite throw site uses domainError, but keeps the route defensive).
function sendDomainError(res, error) {
  const status = Number.isInteger(error?.status) ? error.status : 400;
  const body = {
    error: {
      code: error?.code || "INVALID_CHANGE",
      message: String(error?.message || error),
      resolution: error?.resolution,
      details: error?.details,
      // Some domain errors also carry structured findings and a server-generated repair prompt.
      // Keys are listed explicitly here, so a new field on domainError is dropped silently unless
      // it is added to this list and to portalPostJson.
      findings: error?.findings,
      repair: error?.repair,
    },
  };
  send(res, status, "application/json", JSON.stringify(body));
}

function postJsonRoute(path, run, { domainError = false } = {}) {
  return {
    method: "POST",
    path,
    handler: (req, res, { handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        try {
          send(res, 200, "application/json", JSON.stringify(run(handlers, body || {})));
        } catch (error) {
          if (domainError) return sendDomainError(res, error);
          send(res, 400, "application/json", JSON.stringify({ error: String(error?.message || error) }));
        }
      });
      return true;
    },
  };
}
