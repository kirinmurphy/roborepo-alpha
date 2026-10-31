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

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.spec.mjs",
  timeout: 30_000,
  fullyParallel: false,
  workers: 1,
  // One retry on CI; the list reporter marks a test that passes on retry as flaky, so it stays
  // visible in the log without failing the run.
  retries: process.env.CI ? 1 : 0,
  reporter: [["list"]],
  use: {
    baseURL: process.env.PORTAL_BASE_URL || "http://127.0.0.1:4317",
    headless: true,
    viewport: { width: 1280, height: 800 },
  },
});
