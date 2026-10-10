#!/usr/bin/env node
// Portal UI browser suite driver.
//
// Boots the REAL portal server the hermetic way — temp HOME + ROBOREPO_STATE_DIR, a
// PORTAL_READY_FILE ready-file, and `web --no-open --port 0 --allow-zero-port` — the
// same recipe scripts/test/test-cli.sh uses around its portal HTTP block. The server is a
// sibling process (not a Playwright webServer fixture), so the suite exercises the exact startup
// path a user gets from `roborepo web`, and the port comes from the ready-file so nothing is
// hard-coded.
//
// Skips (exit 0) with a visible `skip:` line when the Chromium browser is not installed, so a
// machine that has never run `npx playwright install chromium` still gets a green, honest result.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { guardPortal } from "../lib/portal-cleanup.mjs";
import {
  defaultRegistry,
  recordDiscovery,
  upsertRepository,
  writeRegistry,
} from "../../../modules/repositories/index.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(here, "..", "..", "..");

const browserPath = chromium.executablePath();
if (!fs.existsSync(browserPath)) {
  console.log(
    "skip: portal UI browser suite (chromium not installed; run `npx playwright install chromium`)",
  );
  process.exit(0);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-"));
const readyFile = path.join(tmp, "portal.ready");
const stateDir = path.join(tmp, ".roborepo");
const registry = defaultRegistry();
upsertRepository(registry, {
  id: "git:github.com/example/roborepo",
  kind: "git",
  displayName: "RoboRepo",
  providerUrl: "https://github.com/example/roborepo",
  now: "2026-09-30T12:00:00.000Z",
});
recordDiscovery(registry, "git:github.com/example/roborepo", {
  source: "manual",
  evidence: "configured-source",
  confidence: "high",
  now: "2026-09-30T12:00:00.000Z",
});
writeRegistry({ stateRoot: stateDir, registry });
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const server = spawn(
  process.execPath,
  [cli, "web", "--no-open", "--port", "0", "--allow-zero-port"],
  {
    cwd: repoRoot,
    env: {
      ...process.env,
      HOME: tmp,
      ROBOREPO_STATE_DIR: stateDir,
      PORTAL_READY_FILE: readyFile,
    },
    stdio: ["ignore", "inherit", "inherit"],
  },
);

// The normal paths below stop the server, but a runner killed while blocked in spawnSync (or by
// SIGKILL) runs none of them; the watchdog stops the server once this process is gone.
guardPortal(server.pid);

let exited = false;
server.once("exit", (code) => {
  exited = true;
  if (code !== 0) {
    console.error(`portal server exited early (code ${code})`);
  }
});

function waitForReadyFile(timeoutMs = 15_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      try {
        if (fs.existsSync(readyFile)) {
          const m = fs.readFileSync(readyFile, "utf8").match(/ready:(\d+)/);
          if (m) {
            const port = Number.parseInt(m[1], 10);
            if (Number.isInteger(port) && port > 0) return resolve(port);
          }
        }
      } catch {}
      if (exited) return reject(new Error("portal server exited before writing the ready file"));
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for ready file"));
      setTimeout(check, 100);
    };
    check();
  });
}

async function main() {
  let port;
  try {
    port = await waitForReadyFile();
  } catch (err) {
    server.kill("SIGTERM");
    fs.rmSync(tmp, { recursive: true, force: true });
    console.error(`error: ${err.message}`);
    process.exit(1);
  }

  const baseURL = `http://127.0.0.1:${port}`;
  const pwCli = path.join(repoRoot, "node_modules", "playwright", "cli.js");
  const config = path.join(here, "playwright.config.mjs");
  const result = spawnSync(
    process.execPath,
    [pwCli, "test", "--config", config],
    {
      cwd: repoRoot,
      env: { ...process.env, PORTAL_BASE_URL: baseURL },
      stdio: "inherit",
    },
  );

  server.kill("SIGTERM");
  fs.rmSync(tmp, { recursive: true, force: true });
  process.exit(result.status ?? 1);
}

main();
