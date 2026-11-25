// /api/packages* routes: the Agents page's client of the package service, beside the CLI
// (package-source-command.mjs). Each route parses the request, makes the one service call the CLI
// makes for the same command, and maps a refusal to an HTTP status with the service's own message,
// code, and details. No package logic lives here.
//
// Calls that run Git (adding a git source, refreshing it, updating) go through a child process
// (package-service-runner.mjs): Git runs synchronously, so in this process it would stop every
// page from answering for as long as the remote takes.
import path from "node:path";
import { send, readJsonBody } from "./portal-routes-http.mjs";
import { defineRoutes } from "./portal-router.mjs";
import {
  PackageServiceError,
  addSource,
  installPackage,
  isFolderLocation,
  listSources,
  packageView,
  previewInstall,
  removePackage,
  removeSource,
  setSourceEnabled,
  sourceInfo,
} from "./package-service.mjs";
import { runPackageServiceInChild } from "./package-service-runner.mjs";
import { currentWriteActor } from "./write-log.mjs";

// Service refusal codes (SERVICE_EXIT_CODES) as HTTP statuses.
const STATUS_BY_CODE = {
  usage: 400,
  invalid: 400,
  ambiguous: 409,
  confirmationRequired: 409,
  refused: 409,
  unavailable: 503,
};

export function statusForServiceError(err) {
  return err instanceof PackageServiceError ? STATUS_BY_CODE[err.code] ?? 500 : 500;
}

function sendJson(res, status, body) {
  send(res, status, "application/json", JSON.stringify(body));
}

function sendFailure(res, err) {
  if (err instanceof PackageServiceError) {
    return sendJson(res, statusForServiceError(err), { ok: false, error: { code: err.code, message: err.message, details: err.details ?? null } });
  }
  console.error("package route failed:", err);
  sendJson(res, 500, { ok: false, error: { code: "internal", message: String(err?.message || err), details: null } });
}

function usage(message) {
  return new PackageServiceError(message, { code: "usage" });
}

// Runs `action` (sync or async) and answers with its result, or with the refusal it threw.
function answer(res, action) {
  Promise.resolve()
    .then(action)
    .then((result) => sendJson(res, 200, { ok: true, result }))
    .catch((err) => sendFailure(res, err));
}

// A JSON-bodied mutation. The write actor is read now, while this request's actor is current, so a
// child process logs its writes as this request.
function withBody(handler) {
  return (req, res, ctx) => {
    const actor = currentWriteActor();
    readJsonBody(req, (body, err) => {
      if (err) return sendFailure(res, usage("invalid JSON body"));
      const payload = body && typeof body === "object" && !Array.isArray(body) ? body : {};
      answer(res, () => handler(payload, { ...ctx, actor }));
    });
    return true;
  };
}

const isRevision = (value) => value === undefined || value === null || (typeof value === "string" && /^[0-9a-f]{40}$/.test(value));

export const packagesRoutes = defineRoutes([
  {
    method: "GET",
    path: "/api/packages",
    handler: (req, res) => {
      answer(res, () => packageView());
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/packages/sources",
    handler: (req, res) => {
      answer(res, () => listSources());
      return true;
    },
  },
  {
    method: "POST",
    path: "/api/packages/sources",
    handler: withBody(({ location, id = null }, { actor }) => {
      if (typeof location !== "string" || !location.trim()) throw usage("expected { location: string, id?: string }");
      if (id !== null && typeof id !== "string") throw usage("expected { location: string, id?: string }");
      // A folder is read from disk, resolved here so it names the folder the server sees; only a
      // git source runs Git.
      if (isFolderLocation(location)) return addSource({ location: path.resolve(location.trim()), id: id?.trim() || null });
      return runPackageServiceInChild("addSource", [{ location, id: id?.trim() || null }], { actor });
    }),
  },
  {
    method: "GET",
    path: "/api/packages/sources/:id",
    handler: (req, res, { params }) => {
      answer(res, () => sourceInfo(params.id));
      return true;
    },
  },
  {
    method: "POST",
    path: "/api/packages/sources/:id/refresh",
    handler: withBody((body, { params, actor }) => runPackageServiceInChild("refreshSources", [params.id], { actor })),
  },
  {
    method: "POST",
    path: "/api/packages/sources/:id/enabled",
    handler: withBody(({ enabled }, { params }) => {
      if (typeof enabled !== "boolean") throw usage("expected { enabled: boolean }");
      return setSourceEnabled(params.id, enabled);
    }),
  },
  {
    method: "DELETE",
    path: "/api/packages/sources/:id",
    handler: (req, res, { params, qs }) => {
      const keepInstalled = new URLSearchParams(qs).get("keepInstalled") === "1";
      answer(res, () => removeSource(params.id, { keepInstalled }));
      return true;
    },
  },
  {
    method: "GET",
    path: "/api/packages/install-preview",
    handler: (req, res, { qs }) => {
      const ref = new URLSearchParams(qs).get("ref");
      answer(res, () => {
        if (!ref) throw usage("expected ?ref=<package>");
        return previewInstall(ref);
      });
      return true;
    },
  },
  {
    // Sent only after the person confirmed the preview, so `confirmed` is implied; `expectedPlan`
    // binds the install to what that preview showed.
    method: "POST",
    path: "/api/packages/install",
    handler: withBody(({ ref, expectedPlan }) => {
      if (typeof ref !== "string" || !ref || !Array.isArray(expectedPlan)) throw usage("expected { ref: string, expectedPlan: array }");
      return installPackage(ref, { confirmed: true, expectedPlan });
    }),
  },
  {
    // Unconfirmed, the service refuses with `confirmationRequired` and the change to show in
    // `details.change`. Confirmed, it moves to exactly the shown `to` from the shown `from`.
    method: "POST",
    path: "/api/packages/update",
    handler: withBody(({ ref, confirmed = false, expectedRevision = null, expectedFrom = null }, { actor }) => {
      if (typeof ref !== "string" || !ref || typeof confirmed !== "boolean" || !isRevision(expectedRevision) || !isRevision(expectedFrom)) {
        throw usage("expected { ref: string, confirmed?: boolean, expectedRevision?: sha, expectedFrom?: sha }");
      }
      const options = confirmed ? { confirmed, expectedRevision, expectedFrom } : {};
      return runPackageServiceInChild("updatePackage", [ref, options], { actor });
    }),
  },
  {
    // `:ref` is URL-encoded (`team%2Ftool`) so a qualified name stays one path segment.
    method: "DELETE",
    path: "/api/packages/installed/:ref",
    handler: (req, res, { params }) => {
      answer(res, async () => {
        const { disablePackage, retireStrandedPackage } = await import("./packages.mjs");
        return removePackage(params.ref, { disable: (id) => disablePackage([id]), retire: retireStrandedPackage });
      });
      return true;
    },
  },
]);
