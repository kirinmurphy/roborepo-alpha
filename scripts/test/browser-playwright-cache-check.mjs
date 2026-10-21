#!/usr/bin/env node
// What `roborepo browser probe` promises from Playwright's browser cache, `run` must deliver. Each
// case points PLAYWRIGHT_BROWSERS_PATH at a cache that links only some of the real one's entries:
//
// - the full browser alone, or a headless shell of the wrong revision: not available, because a
//   headless launch needs the matching headless shell;
// - the matching headless shell alone: available, and a run passes;
// - no ffmpeg: video is reported unavailable, and a run asked to record says so rather than
//   returning nothing.
//
// Skips with a visible `skip:` line when Chromium is not installed, matching
// scripts/test/portal-ui/run.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "@playwright/test";
import { createBrowserCliHome } from "./lib/browser-cli-home.mjs";
import { startFixtureApp } from "./lib/local-http.mjs";

const location = /^(.*)[\\/]chromium-(\d+)[\\/]/.exec(chromium.executablePath());
const shell = location && `chromium_headless_shell-${location[2]}`;
if (!location || !fs.existsSync(path.join(location[1], shell))) {
  console.log("skip: browser playwright cache (chromium headless shell not installed; run `npx playwright install chromium`)");
  process.exit(0);
}
const [, cacheRoot, revision] = location;

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const cli = createBrowserCliHome("roborepo-browser-cache-");
const app = await startFixtureApp();

try {
  assert.equal(cli.run(["package", "enable", "feature-verification"]).status, 0);
  const project = path.join(cli.home, "project");
  fs.mkdirSync(project);
  fs.symlinkSync(path.join(repoRoot, "node_modules"), path.join(project, "node_modules"), "junction");
  const scenario = path.join(project, "check.mjs");
  fs.writeFileSync(scenario, [
    "export default async function ({ page, url, check }) {",
    "  await page.goto(url);",
    '  await check("heading renders", async () => {',
    '    if ((await page.getByRole("heading").textContent()) !== "Fixture") throw new Error("wrong heading");',
    "  });",
    "}",
    "",
  ].join("\n"));

  const fullOnly = partialCache("full-only", [`chromium-${revision}`]);
  const noShell = await probe(fullOnly);
  assert.equal(noShell.available, false, "the full browser without its headless shell is not available");
  assert.match(noShell.limitations.join("\n"), /install chromium/, "the limitation names the browser install command");

  const wrongRevision = partialCache("wrong-revision", [`chromium-${revision}`]);
  fs.mkdirSync(path.join(wrongRevision, "chromium_headless_shell-1"));
  assert.equal((await probe(wrongRevision)).available, false, "a headless shell of another revision does not count");

  // The matching shell alone (what `playwright install --only-shell` leaves) is enough, and has no ffmpeg.
  const shellOnly = partialCache("shell-only", [shell]);
  const probed = await probe(shellOnly);
  assert.equal(probed.available, true, "the matching headless shell alone is available");
  assert.deepEqual(probed.capabilities, { screenshot: true, video: false, trace: true });
  assert.match(probed.limitations.join("\n"), /install ffmpeg/, "missing video support names the ffmpeg install command");

  const recorded = await browser(shellOnly, ["run", "--scenario", scenario, "--url", app.url, "--capture", "video", "--json"]);
  assert.equal(recorded.status, "passed", "what probe reported available actually runs");
  assert.ok(!recorded.artifacts.some((artifact) => artifact.type === "video"), "no video is fabricated");
  assert.match(recorded.limitations.join("\n"), /video capture unavailable/);

  console.log("ok: browser playwright cache (headless shell revision, shell-only, missing ffmpeg)");
} finally {
  app.close();
  cli.cleanup();
}

function probe(browsersPath) {
  return browser(browsersPath, ["probe", "--dir", path.join(cli.home, "project"), "--json"]);
}

// Asynchronous, because the fixture app is served from this process.
async function browser(browsersPath, args) {
  const { stdout } = await cli.start(["browser", ...args], { PLAYWRIGHT_BROWSERS_PATH: browsersPath }).done;
  return JSON.parse(stdout);
}

// A browser cache holding only the named entries of the real one, linked rather than copied.
function partialCache(name, entries) {
  const dir = path.join(cli.home, `cache-${name}`);
  fs.mkdirSync(dir);
  for (const entry of entries) fs.symlinkSync(path.join(cacheRoot, entry), path.join(dir, entry), "junction");
  return dir;
}
