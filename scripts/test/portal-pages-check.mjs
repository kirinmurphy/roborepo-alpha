#!/usr/bin/env node
// Portal routing manifest check.
//
// PAGES order defines the global nav (Home, Agents, Plans, Tokens, Runtime, Settings).
// This check pins the manifest invariants that a future routing refactor could silently break:
// canonical paths, exactly one default page, and the nav order that theme.js renders from
// window.PORTAL_MANIFEST.
//
// Importing PAGES from portal-server.mjs also runs validateRouteTables() at module load, so an
// invalid route table fails loudly here even before any browser assertion.

import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PAGES, PAGE_ROUTES, matchPortalPage, serializeInlineJson } from "../../scripts/cli/portal-server.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..");

// Canonical page map: order is the nav order, and each route is unique (no alias).
const EXPECTED = [
  { path: "/", id: "home", title: "Repos", dir: "home", default: true },
  { path: "/config", id: "config", title: "Agents", dir: "config" },
  { path: "/plans", id: "plans", title: "Plans", dir: "plans" },
  { path: "/tokens", id: "tokens", title: "Tokens", dir: "tokens" },
  { path: "/runtime", id: "developer-runtime", title: "Runtime", dir: "developer-runtime" },
  { path: "/settings", id: "settings", title: "Settings", dir: "settings" },
];

// The browser-safe manifest must expose exactly the path/id/title triples in PAGES order.
// pageManifest() (in portal-server.mjs) maps PAGES to this shape; asserting the derived shape
// keeps the browser-injected nav and the /api/portal/status payload honest to the same order.
assert.deepEqual(
  PAGES.map(({ path, id, title }) => ({ path, id, title })),
  EXPECTED.map(({ path, id, title }) => ({ path, id, title })),
  "PAGES-derived manifest must mirror PAGES in order with the browser-safe shape",
);

// Full PAGES shape (path, id, title, dir, default) matches the canonical map exactly. PAGES only
// sets `default` on the home entry; the other pages omit it (undefined), so compare with that
// optionality rather than demanding an explicit false.
assert.deepEqual(
  PAGES.map(({ path, id, title, dir, default: d }) => ({ path, id, title, dir, default: d })),
  EXPECTED.map(({ path, id, title, dir, default: d }) => ({ path, id, title, dir, default: d })),
  "PAGES must hold the canonical pages in nav order",
);

// Exactly one default page, and it is Home — `roborepo web` opens `/`.
const defaults = PAGES.filter((p) => p.default);
assert.equal(defaults.length, 1, "exactly one page must be marked default");
assert.equal(defaults[0].path, "/", "the default page must be Home at /");
assert.equal(defaults[0].id, "home", "the default page id must be home");

// No aliasing: every path is distinct, and no page id appears twice (removes the old /↔/config
// Agents alias special case from PAGE_BY_PATH).
assert.equal(new Set(PAGES.map((p) => p.path)).size, PAGES.length, "every route must be unique");
assert.equal(new Set(PAGES.map((p) => p.id)).size, PAGES.length, "every page id must be unique");

// Each navigable page's index.html must exist on disk. Home is now repository-first and therefore
// owns a loading state plus a page-local module.
for (const page of PAGES) {
  const indexHtml = path.join(repoRoot, "portal", page.dir, "index.html");
  assert.ok(fs.existsSync(indexHtml), `portal/${page.dir}/index.html must exist`);
  const html = fs.readFileSync(indexHtml, "utf8");
  if (page.id === "home") {
    assert.ok(html.includes("{{LOADING}}"), "repository Home renders a first-load state");
    assert.ok(html.includes(`/portal/${page.dir}/app.js`), "repository Home loads its page module");
  }
}

assert.equal(PAGES.length, 6, "dynamic detail must not enter the six-item navigation manifest");
assert.equal(PAGE_ROUTES.length, 7, "page-route table adds exactly one non-navigable dynamic route");
const detailRoute = PAGE_ROUTES.find((page) => page.path === "/repositories/:urlKey");
assert.ok(detailRoute, "repository detail route is registered");
assert.equal(detailRoute.navId, "home", "repository detail belongs to Home navigation");
assert.equal(detailRoute.redirect, "/", "the parked detail page redirects Home");
assert.ok(fs.existsSync(path.join(repoRoot, "portal", detailRoute.dir, "index.html")));
assert.equal(matchPortalPage("/repositories/roborepo").params.urlKey, "roborepo");
assert.equal(matchPortalPage("/repositories/hello%20world").params.urlKey, "hello world", "route params decode once");
assert.equal(matchPortalPage("/repositories/%E0%A4%A"), null, "malformed path encoding does not match");
assert.equal(matchPortalPage("/repositories/roborepo/extra"), null);
const inlineJson = serializeInlineJson({ routeParams: { urlKey: "</script><script>alert(1)</script>" } });
assert.equal(inlineJson.includes("</script>"), false, "decoded route parameters cannot end the inline manifest script");
assert.deepEqual(JSON.parse(inlineJson), { routeParams: { urlKey: "</script><script>alert(1)</script>" } });

console.log("ok: portal page manifest (routes, default, nav order) checks passed");
