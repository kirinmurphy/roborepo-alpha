// /api/config* routes — the Config page's API surface. handlers is the object startPortalServer()
// was given (loadConfig, loadConfigSource, mutatePackage, mutateSkill, mutateBehavior,
// mutateCommand come from telemetry.mjs's wiring).
import { send, readJsonBody } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";

// Mutations are POST-only, origin-checked, token-checked, and JSON-bodied (route() already ran
// the origin+token guard). Each writes config then returns the fresh snapshot so the client
// re-renders from one response.
function handleToggle(urlPath) {
  return (req, res, { handlers }) => {
    const { loadConfig, mutatePackage, mutateSkill } = handlers;
    readJsonBody(req, async (body, err) => {
      if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
      const { id, enabled } = body || {};
      if (typeof id !== "string" || typeof enabled !== "boolean") {
        return send(res, 400, "application/json", JSON.stringify({ error: "expected { id: string, enabled: boolean }" }));
      }
      const mutate = urlPath === "/api/config/packages" ? mutatePackage : mutateSkill;
      const result = await mutate(id, enabled); // mutatePackage is async (service components)
      const status = result.ok ? 200 : 400;
      send(res, status, "application/json", JSON.stringify({ ...result, config: loadConfig() }));
    });
    return true;
  };
}

export const configRoutes = defineRoutes([
  {
    method: "POST",
    path: "/api/config/harnesses/refresh",
    handler: (req, res, { handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        Promise.resolve()
          .then(() => handlers.refreshHarnesses())
          .then((result) => send(res, 200, "application/json", JSON.stringify({
            ok: true,
            detected: result.detected,
            newlyEnabled: result.newlyEnabled ?? [],
            applied: result.applied ?? null,
            config: handlers.loadConfig(),
          })))
          .catch((error) => send(res, 400, "application/json", JSON.stringify({ error: String(error?.message || error) })));
      });
      return true;
    },
  },
  {
    method: "POST",
    path: "/api/config/harnesses/:id/enabled",
    handler: (req, res, { params, handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        if (typeof body?.enabled !== "boolean") {
          return send(res, 400, "application/json", JSON.stringify({ error: "expected { enabled: boolean }" }));
        }
        try {
          handlers.setHarnessEnabled(params.id, body.enabled);
          send(res, 200, "application/json", JSON.stringify({ ok: true, config: handlers.loadConfig() }));
        } catch (error) {
          send(res, 400, "application/json", JSON.stringify({ error: String(error?.message || error) }));
        }
      });
      return true;
    },
  },
  { method: "POST", path: "/api/config/packages", handler: handleToggle("/api/config/packages") },
  { method: "POST", path: "/api/config/skills", handler: handleToggle("/api/config/skills") },
  {
    // Section-level bulk enable/disable (bulkToggle sections only; the client sends the whole
    // section's package ids). One request = one unit: preflighted sequential mutations, then a
    // single reconcile pass, then the fresh snapshot. 409 when another batch is in flight or
    // preflight rejects (ownership conflicts) — results carries per-id detail for the UI.
    method: "POST",
    path: "/api/config/packages/bulk",
    handler: (req, res, { handlers }) => {
      const { loadConfig, bulkPackageChange } = handlers;
      readJsonBody(req, async (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        const { ids, enabled } = body || {};
        if (!Array.isArray(ids) || ids.some((id) => typeof id !== "string") || typeof enabled !== "boolean") {
          return send(res, 400, "application/json", JSON.stringify({ error: "expected { ids: string[], enabled: boolean }" }));
        }
        const result = await bulkPackageChange(ids, enabled);
        send(res, result.status, "application/json", JSON.stringify({ ...result, config: loadConfig() }));
      });
      return true;
    },
  },
  {
    // Flat model: either a named behavior (by manifest id) or an arbitrary command (by token
    // array) moves to a bucket. "default" reverts to the manifest's own default for that item.
    // Global only — no profile, no scope; see permissions-render.mjs / config-mutate.mjs.
    method: "POST",
    path: "/api/config/permissions",
    handler: (req, res, { handlers }) => {
      const { loadConfig, mutateBehavior, mutateCommand } = handlers;
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        const { behaviorId, tokens, bucket } = body || {};
        const validBucket = bucket === "default" || ["deny", "ask", "allow"].includes(bucket);
        if (!validBucket || (typeof behaviorId !== "string" && !Array.isArray(tokens))) {
          return send(res, 400, "application/json", JSON.stringify({
            error: "expected { behaviorId: string, bucket } or { tokens: string[], bucket } — bucket one of deny|ask|allow|default",
          }));
        }
        const result = typeof behaviorId === "string"
          ? mutateBehavior(behaviorId, bucket)
          : mutateCommand(tokens, bucket);
        const status = result.ok ? 200 : 400;
        send(res, status, "application/json", JSON.stringify({ ...result, config: loadConfig() }));
      });
      return true;
    },
  },
  {
    // `?fresh=1` skips the server's cached read: after a hook change, on Check again, and when the
    // page regains focus, since trust can change in the harness without RoboRepo knowing.
    path: "/api/config/hooks/:harness/status",
    handler: (req, res, { params, qs, handlers }) => {
      const fresh = new URLSearchParams(qs).get("fresh") === "1";
      Promise.resolve()
        .then(() => handlers.loadHookReadiness(params.harness, { fresh }))
        .then((status) => send(res, 200, "application/json", JSON.stringify(status)))
        .catch((error) => {
          if (/unsupported harness/.test(String(error?.message))) {
            return send(res, 404, "application/json", JSON.stringify({ error: String(error.message) }));
          }
          // Readiness is advisory: a failed read reports "unknown" so the page keeps rendering.
          send(res, 200, "application/json", JSON.stringify({ harness: params.harness, state: "unknown", groups: [] }));
        });
      return true;
    },
  },
  {
    // Opens the harness's own hook review in a terminal, on a user click. The body must be empty:
    // the executable, its arguments, and the working directory are the server's choice alone.
    method: "POST",
    path: "/api/config/hooks/:harness/review",
    handler: (req, res, { params, handlers }) => {
      readJsonBody(req, (body, err) => {
        if (err) return send(res, 400, "application/json", JSON.stringify({ error: "invalid JSON body" }));
        if (body && (typeof body !== "object" || Array.isArray(body) || Object.keys(body).length > 0)) {
          return send(res, 400, "application/json", JSON.stringify({ error: "expected an empty body" }));
        }
        Promise.resolve()
          .then(() => handlers.launchHookReview(params.harness))
          .then((result) => send(res, 200, "application/json", JSON.stringify(result)))
          .catch((error) => {
            const status = /unsupported harness/.test(String(error?.message)) ? 404 : 500;
            send(res, status, "application/json", JSON.stringify({ ok: false, error: String(error?.message || error) }));
          });
      });
      return true;
    },
  },
  {
    path: "/api/config",
    handler: (req, res, { handlers }) => {
      send(res, 200, "application/json", JSON.stringify(handlers.loadConfig()));
      return true;
    },
  },
  {
    // Read-only: returns the full source that defines a tool (skill/command/rules/hooks) for the
    // /agents click-to-inspect popup. loadConfigSource whitelists kind+id against the catalog.
    path: "/api/config/source",
    handler: (req, res, { qs, handlers }) => {
      const params = new URLSearchParams(qs);
      const result = handlers.loadConfigSource({
        kind: params.get("kind"),
        id: params.get("id"),
        harness: params.get("harness"),
      });
      send(res, result.ok ? 200 : 400, "application/json", JSON.stringify(result));
      return true;
    },
  },
]);
