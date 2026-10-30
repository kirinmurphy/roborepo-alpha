#!/usr/bin/env node
// Reusable hermetic-portal capture utility — boots a disposable portal, optionally seeds the
// /tokens mock spool, captures full-page screenshots (dark + light), and stops the server.
//
// Usage:
//   node scripts/test/portal-ui/capture.mjs [--seed-tokens] [--page /tokens] [--out /tmp/rr-shots]
//
// Flags:
//   --seed-tokens   Copy portal/tokens/mock-spool.jsonl into the hermetic spool dir so
//                    /tokens renders its full mock report (spikes, loops, reads, testing,
//                    marker comparison). Without it the page renders its empty/no-data state.
//   --page <path>    Page path to capture (default /tokens).
//   --out <dir>      Output directory for PNGs (default /tmp/rr-shots).
//
// Gotchas it encapsulates:
//   - The capture half needs the REAL $HOME (Playwright browser cache) while the server
//     keeps its hermetic HOME — handled by spawning the server with a modified env only.
//   - The server runs as a foreground child (lib/portal-cleanup.mjs), so it stops with this
//     script on every exit path, including SIGKILL. A `--detach` server outlived the script: its
//     PID file is keyed by the port it bound, which a bare `web stop` never finds.
//   - Theme switching is data-attribute + localStorage (`portal-theme`), not media emulation.

import { startHermeticPortal } from "../lib/portal-cleanup.mjs";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const require = createRequire(import.meta.url);

// ── Args ──
const args = process.argv.slice(2);
const flag = (name) => args.includes(name);
const value = (name, fallback) => {
  const i = args.indexOf(name);
  return i !== -1 && args[i + 1] && !args[i + 1].startsWith("--") ? args[i + 1] : fallback;
};
const seedTokens = flag("--seed-tokens");
const pagePath = value("--page", "/tokens");
const outDir = path.resolve(value("--out", "/tmp/rr-shots"));

fs.mkdirSync(outDir, { recursive: true });

// ── Hermetic boot (server process gets a temp HOME + state dir) ──
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "rr-capture-"));
const stateDir = path.join(tmp, ".roborepo");

if (seedTokens) {
  const spoolDir = path.join(stateDir, "telemetry", "spool");
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.copyFileSync(
    path.join(repoRoot, "portal", "tokens", "mock-spool.jsonl"),
    path.join(spoolDir, "claude.jsonl"),
  );
  console.log(`seeded /tokens mock spool → ${spoolDir}/claude.jsonl`);
}

const serverEnv = { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: stateDir };
process.on("exit", () => {
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* best effort */ }
});

let port;
try {
  ({ port } = await startHermeticPortal({
    env: serverEnv,
    readyFile: path.join(tmp, "portal.ready"),
    logFile: path.join(tmp, "boot.log"),
  }));
} catch (err) {
  console.error(err.message);
  process.exit(1);
}
console.log(`portal ready on http://127.0.0.1:${port}`);

// ── Capture (real $HOME so Playwright finds its browser binary) ──
const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
page.on("pageerror", (e) => console.log("PAGEERROR", e.message));
await page.goto(`http://127.0.0.1:${port}${pagePath}`, { waitUntil: "networkidle" });
await page.waitForTimeout(1200); // async fetch/render after networkidle

await page.screenshot({ path: path.join(outDir, "capture-dark.png"), fullPage: true });
await page.evaluate(() => {
  document.documentElement.dataset.theme = "light";
  localStorage.setItem("portal-theme", "light");
});
await page.waitForTimeout(300);
await page.screenshot({ path: path.join(outDir, "capture-light.png"), fullPage: true });
await browser.close();

console.log(`captured ${pagePath} → ${outDir}/capture-{dark,light}.png`);