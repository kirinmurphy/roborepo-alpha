// Tiny HTTP helpers shared by every portal-routes-*.mjs handler: uniform JSON/text response
// writing and body-reading. No page-specific logic lives here.

// Default: no-store, correct for the token-bearing HTML pages and the live API JSON. Static-asset
// handlers pass `headers` to override (ETag + no-cache) so browsers can revalidate CSS/JS with a
// cheap 304 instead of re-downloading on every page nav.
export function send(res, status, type, body, headers) {
  res.writeHead(status, {
    "Content-Type": type,
    "Cache-Control": "no-store",
    ...headers,
  });
  res.end(body);
}

// Local control payloads are tiny; a route carrying a document passes its own limit.
export function readJsonBody(req, cb, { limit = 64 * 1024 } = {}) {
  let raw = "";
  let tooBig = false;
  req.on("data", (chunk) => {
    raw += chunk;
    if (raw.length > limit) { tooBig = true; req.destroy(); }
  });
  req.on("end", () => {
    if (tooBig) return cb(null, new Error("body too large"));
    try { cb(raw ? JSON.parse(raw) : {}, null); } catch (err) { cb(null, err); }
  });
  req.on("error", (err) => cb(null, err));
}
