// Playwright config for the portal UI suite.
//
// This suite intentionally does NOT live in a `*-check.mjs` file: the auto-discovery glob in
// scripts/test/run-checks.mjs only scans scripts/test/ top-level files, and plain `npm test` /
// `npm run test:unit` must stay browser-free. Run it explicitly via `npm run test:portal-ui`
// (or the CI gate in scripts/test/ci.sh), which boots the real portal server the hermetic way and
// points Playwright at it through PORTAL_BASE_URL (see run.mjs).
//
// The repo is `"type": "module"`, so config + specs are ESM. Only Chromium is exercised — the
// suite targets the portal's real behavior, not browser-Engine matrix coverage.

import { defineConfig } from "@playwright/test";

// No fallback port. The specs register fixture repos and remove every repo source, so pointing
// them at a default port reaches the user's real portal and writes test repos into their real
// registry. Only run.mjs, which boots a server on a temp state root, may supply the address.
const baseURL = process.env.PORTAL_BASE_URL;
if (!baseURL) {
  throw new Error("PORTAL_BASE_URL is not set. Run the portal UI suite with `npm run test:portal-ui`, which starts an isolated portal; never point it at a real one.");
}

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // One retry on CI; the list reporter marks a test that passes on retry as flaky, so it stays
  // visible in the log without failing the run.
  retries: process.env.CI === "true" ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL,
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
});
