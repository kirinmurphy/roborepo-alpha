// Shared route-table matcher for every portal-routes-*.mjs domain. Each domain file exports an
// array of { method, path, handler } entries (path may contain :param segments) instead of its own
// if-chain; dispatchRoutes() below is the one place that turns (method, urlPath) into a match. This
// keeps the full route surface enumerable in one place — see routes() below — which is what lets a
// future OpenAPI doc be generated from these tables instead of hand-maintained.
//
// handler signature: (req, res, ctx) => true, where ctx is { params, qs, handlers }. A handler
// that intentionally didn't handle the request (shouldn't happen once matched, but mirrors the old
// handleXApi contract) may still return false/undefined; dispatchRoutes treats that as "not
// handled" and keeps trying.

export function defineRoutes(entries) {
  return entries.map((entry) => ({ ...entry, segments: entry.path.split("/").filter(Boolean) }));
}

// Called once at startup (see main.mjs) so a copy-pasted or malformed route entry fails loudly
// before the server ever binds a port, instead of silently shadowing/never matching at request
// time. Mirrors command-catalog.mjs's validateCommandCatalog — same "duplicate path" class of bug,
// same fail-fast-at-startup treatment.
export function validateRouteTables(tables) {
  const seen = new Set();
  for (const table of tables) {
    for (const route of table) {
      if (typeof route.path !== "string" || !route.path.startsWith("/")) {
        throw new Error(`portal route path must start with "/": ${JSON.stringify(route.path)}`);
      }
      if (typeof route.handler !== "function") {
        throw new Error(`portal route missing a handler function: ${route.method || "*"} ${route.path}`);
      }
      // :param names don't affect matching (only segment position does), so two routes that only
      // differ by param name would otherwise collide silently at request time — normalize before
      // comparing.
      const shape = route.segments.map((seg) => (seg.startsWith(":") ? ":" : seg)).join("/");
      const key = `${route.method || "*"} /${shape}`;
      if (seen.has(key)) throw new Error(`duplicate portal route: ${key}`);
      seen.add(key);
    }
  }
}

// Generates a minimal-but-valid OpenAPI document straight from the route tables — the "future
// OpenAPI doc" flagged as a follow-up when the registry was built. No hand-maintained doc to drift:
// a route added to any table shows up here on the next request, same guarantee /manifest.json and
// /sitemap.xml already have from PAGES. Deliberately minimal (paths + methods only, no
// request/response schemas — nothing here has types to generate them from) since the only consumer
// today is metadata.mjs's discoverOpenApiPaths, which only reads Object.keys(doc.paths).
export function buildOpenApiDocument(tables, { title, version = "0.0.0" } = {}) {
  const paths = {};
  for (const table of tables) {
    for (const route of table) {
      // OpenAPI path templates use {param}, not portal-router's :param.
      const openApiPath = "/" + route.segments.map((seg) => (seg.startsWith(":") ? `{${seg.slice(1)}}` : seg)).join("/");
      const methods = paths[openApiPath] || (paths[openApiPath] = {});
      const method = (route.method || "get").toLowerCase();
      methods[method] = { responses: { 200: { description: "OK" } } };
    }
  }
  return { openapi: "3.0.0", info: { title, version }, paths };
}

export function dispatchRoutes(tables, req, res, urlPath, qs, handlers) {
  const methodMatches = [];
  for (const table of tables) {
    for (const route of table) {
      const params = matchSegments(route.segments, urlPath);
      if (params === null) continue;
      if (route.method && route.method !== req.method) {
        methodMatches.push(route);
        continue;
      }
      const handled = route.handler(req, res, { params, qs, handlers });
      if (handled !== false) return true;
    }
  }
  if (methodMatches.length) {
    res.writeHead(405, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "method not allowed" }));
    return true;
  }
  return false;
}

export function matchSegments(routeSegments, urlPath) {
  const pathSegments = urlPath.split("/").filter(Boolean);
  if (routeSegments.length !== pathSegments.length) return null;
  const params = {};
  for (let i = 0; i < routeSegments.length; i++) {
    const routeSeg = routeSegments[i];
    const pathSeg = pathSegments[i];
    if (routeSeg.startsWith(":")) {
      try {
        params[routeSeg.slice(1)] = decodeURIComponent(pathSeg);
      } catch {
        return null;
      }
    } else if (routeSeg !== pathSeg) {
      return null;
    }
  }
  return params;
}
