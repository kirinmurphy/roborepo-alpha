#!/usr/bin/env node
// Regenerates the portal and CLI screenshots used in the README and user docs.
//
// Usage:
//   node scripts/dev/docs-screenshots.mjs            # write PNGs to docs/images/
//   node scripts/dev/docs-screenshots.mjs --survey   # list each page's sections, write nothing
//   node scripts/dev/docs-screenshots.mjs --pages /tokens   # only these pages (comma-separated); skips the CLI menu shot
//   node scripts/dev/docs-screenshots.mjs --out <dir>
//
// Everything runs against a disposable HOME, so no screenshot shows the machine it was taken on:
//   - Harnesses: stub `claude` / `codex` binaries on PATH, then `roborepo init`, a typical package
//     set, and telemetry enabled.
//   - Tokens: the repo's own mock spool (portal/tokens/mock-spool.jsonl).
//   - Plans: this repository's docs/plans (public content), added as a repository source.
//   - Runtime: two demo apps in throwaway git repos with example remotes (acme/*). Auto-discovery
//     is turned on and scans the real machine's listeners, so the page's snapshot is filtered to
//     the demo apps before it renders.
// Each shot is one page section (an element screenshot), not a full page.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";
import { addRepositorySource, setRepositorySourceEnabled } from "../cli/repository-sources.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts", "cli", "main.mjs");
const require = createRequire(import.meta.url);

const args = process.argv.slice(2);
const survey = args.includes("--survey");
const pagesIndex = args.indexOf("--pages");
const onlyPages = pagesIndex !== -1 ? args[pagesIndex + 1].split(",") : null;
const log = (message) => console.error(`[docs-screenshots] ${message}`);
const outIndex = args.indexOf("--out");
const outDir = path.resolve(outIndex !== -1 ? args[outIndex + 1] : path.join(repoRoot, "docs", "images"));

const PACKAGES = [
  "plan-write",
  "code-style",
  "javascript-typescript",
  "test-harness",
  "response-shape",
  "convention-capture",
  "skill-visibility",
];

const home = fs.mkdtempSync(path.join(os.tmpdir(), "rr-docshots-"));
const children = [];
function cleanup() {
  for (const child of children) {
    try { child.kill("SIGTERM"); } catch { /* already gone */ }
  }
  try { fs.rmSync(home, { recursive: true, force: true }); } catch { /* best effort */ }
}
process.on("exit", cleanup);
for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => process.exit(1));

const env = {
  ...process.env,
  HOME: home,
  ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
  PATH: `${path.join(home, "stub-bin")}:${process.env.PATH}`,
  ROBOREPO_PRESETS_ONBOARD: "skip",
  SKIP_MCP: "1",
};
for (const key of ["ROBOREPO_WORKSPACE_ROOT", "ROBOREPO_APP_ROOT"]) delete env[key];

function roborepo(...cliArgs) {
  const result = spawnSync(process.execPath, [cli, ...cliArgs], { cwd: repoRoot, env, encoding: "utf8", input: "" });
  if (result.status !== 0) throw new Error(`roborepo ${cliArgs.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  return result.stdout;
}

// ── Disposable, fully set-up HOME ──
function setUpHome() {
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(path.join(home, "stub-bin"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
  for (const [name, version] of [["claude", "2.1.0 (Claude Code)"], ["codex", "codex-cli 0.140.0"]]) {
    const bin = path.join(home, "stub-bin", name);
    fs.writeFileSync(bin, `#!/bin/sh\necho "${version}"\n`);
    fs.chmodSync(bin, 0o755);
  }
  roborepo("init");
  for (const id of PACKAGES) roborepo("package", "enable", id);
  roborepo("telemetry", "enable");
  const spoolDir = path.join(home, ".roborepo", "telemetry", "spool");
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.copyFileSync(path.join(repoRoot, "portal", "tokens", "mock-spool.jsonl"), path.join(spoolDir, "claude.jsonl"));
  // Repositories are found only through sources the user turned on: this checkout for Plans, and
  // auto-discovery for the Runtime demo apps.
  const stateRoot = env.ROBOREPO_STATE_DIR;
  addRepositorySource({ path: repoRoot, kind: "repository", stateRoot, homeDir: home });
  setRepositorySourceEnabled({ id: "auto-discovery", enabled: true, stateRoot, homeDir: home });
}

// ── Demo apps for Runtime ──
function git(cwd, ...gitArgs) {
  spawnSync("git", ["-c", "user.name=Demo", "-c", "user.email=demo@example.com", ...gitArgs], { cwd });
}

function startDemoApp({ name, remote, title, branch, dirty }) {
  const dir = path.join(home, "projects", name);
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q", "-b", "main");
  git(dir, "remote", "add", "origin", remote);
  fs.writeFileSync(
    path.join(dir, "server.mjs"),
    `import http from "node:http";
http.createServer((req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<title>${title}</title><h1>${title}</h1>");
}).listen(0, "127.0.0.1", function () { console.log(this.address().port); });
`,
  );
  git(dir, "add", ".");
  git(dir, "commit", "-qm", "Initial commit");
  if (branch) git(dir, "checkout", "-q", "-b", branch);
  if (dirty) fs.appendFileSync(path.join(dir, "server.mjs"), "// work in progress\n");
  const child = spawn(process.execPath, ["server.mjs"], { cwd: dir, stdio: ["ignore", "pipe", "ignore"] });
  children.push(child);
  return new Promise((resolve) => child.stdout.once("data", (data) => resolve(Number(String(data).trim()))));
}

const DEMO_PREFIX = "git:github.com/acme/";

// Keeps only the demo apps in a Runtime snapshot and replaces the disposable HOME path.
function filterDeveloperRuntime(snapshot) {
  const demo = (id) => typeof id === "string" && id.startsWith(DEMO_PREFIX);
  const filtered = {
    ...snapshot,
    warnings: [],
    projects: snapshot.projects.filter((project) => demo(project.identity)),
    composeProjects: [],
    unmatchedInstances: [],
    repositories: snapshot.repositories.filter((repo) => demo(repo.repositoryId)),
    inactiveProjects: [],
    hiddenRepositories: [],
    hiddenCount: 0,
  };
  return JSON.parse(JSON.stringify(filtered).split(home).join("~"));
}

// ── Portal ──
async function startPortal() {
  const readyFile = path.join(home, "portal.ready");
  const server = spawn(process.execPath, [cli, "web", "--no-open", "--port", "0", "--allow-zero-port"], {
    cwd: repoRoot,
    env: { ...env, PORTAL_READY_FILE: readyFile },
    stdio: ["ignore", "ignore", "inherit"],
  });
  children.push(server);
  for (let i = 0; i < 900; i++) {
    try {
      const port = Number(/ready:(\d+)/.exec(fs.readFileSync(readyFile, "utf8"))?.[1]);
      if (port > 0) return port;
    } catch { /* not written yet */ }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("portal never became ready");
}

// ── CLI main menu, rendered from a real capture ──
function captureMenu() {
  const raw = path.join(home, "menu.raw");
  spawnSync("sh", ["-c", `(sleep 3; printf q) | script -q "${raw}" sh -c 'stty cols 120 rows 40; exec node "${cli}"' >/dev/null 2>&1`], {
    cwd: repoRoot,
    env,
  });
  const text = fs.readFileSync(raw, "utf8");
  // First frame only: everything before the menu redraws on exit.
  const frame = text.split("\x1b[H\x1b[J").filter(Boolean)[0] ?? text;
  return frame.split(/\r?\n/).map((line) => line.replace(/\r/g, "").replace(/\x1b\[2K/g, "").replace(/\x1b[78]/g, "").replace(/\x1b\[J/g, ""));
}

function ansiToHtml(lines) {
  const colors = { "1;36": "#5fd7d7;font-weight:600", "38;5;245": "#8a8a8a", "38;5;67": "#5f87af" };
  const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  return lines
    .map((line) => {
      let html = "";
      let open = false;
      for (const part of line.split(/(\x1b\[[0-9;]*m)/)) {
        const m = /^\x1b\[([0-9;]*)m$/.exec(part);
        if (!m) { html += esc(part); continue; }
        if (open) { html += "</span>"; open = false; }
        if (m[1] && m[1] !== "0" && colors[m[1]]) { html += `<span style="color:${colors[m[1]]}">`; open = true; }
      }
      return html + (open ? "</span>" : "");
    })
    .join("\n");
}

// ── Shots: one page section each ──
// A shot is either one element (`element`) or a vertical band from the top of `from` to the bottom
// of `to`, as wide as the page's content column (`main`) plus a little padding.
const SHOTS = [
  { file: "portal-home.png", page: "/", from: "header.portal-header", to: "a.home-card >> nth=-1" },
  {
    file: "runtime.png",
    page: "/runtime",
    from: "section#content",
    to: "section#content",
    fromPad: 0,
    // Expand the first app so its running instance (health, process, branch) is visible.
    prepare: async () => {
      await page.getByText("1 member").first().click();
      await page.waitForTimeout(800);
    },
  },
  { file: "plans.png", page: "/plans", from: "header.portal-header", fromEdge: "bottom", to: "article.plan-card >> nth=0" },
  { file: "agents-config.png", page: "/config", element: "section.panel:has(h2:text-is('Skills - Development Life Cycle'))" },
  { file: "harness-files.png", page: "/config", element: "section.panel.wide >> nth=0" },
  { file: "tokens.png", page: "/tokens", from: "#tokensmeta", to: "div.finding >> nth=0" },
];
const PAD = 20;
const BOTTOM_PAD = 12;

async function captureShot(shot, file) {
  if (shot.prepare) await shot.prepare();
  if (shot.element) {
    await page.locator(shot.element).first().screenshot({ path: file });
    return;
  }
  const frame = await page.locator("main").first().boundingBox();
  const from = await page.locator(shot.from).first().boundingBox();
  const to = await page.locator(shot.to).first().boundingBox();
  const fromPad = shot.fromPad ?? (shot.from.startsWith("header") ? 0 : PAD);
  const top = shot.fromEdge === "bottom" ? from.y + from.height : Math.max(0, from.y - fromPad);
  const clip = {
    x: Math.max(0, frame.x - PAD),
    y: top,
    width: frame.width + PAD * 2,
    height: to.y + to.height + BOTTOM_PAD - top,
  };
  await page.screenshot({ path: file, clip, fullPage: true });
}

async function surveyPage(page, pagePath) {
  const rows = await page.evaluate(() => {
    const describe = (el) => {
      const id = el.id ? `#${el.id}` : "";
      const cls = el.className && typeof el.className === "string" ? `.${el.className.trim().split(/\s+/).join(".")}` : "";
      const box = el.getBoundingClientRect();
      return `${el.tagName.toLowerCase()}${id}${cls}  y=${Math.round(box.top + scrollY)} h=${Math.round(box.height)}`;
    };
    return [...document.querySelectorAll("body > header, body > nav, header, main > *, main section, main article, main [id], main .card, main [class*=card], main [class*=finding], main [class*=bar]")]
      .slice(0, 60)
      .map((el) => `${describe(el)}  "${(el.querySelector("h1,h2,h3")?.textContent ?? el.textContent ?? "").trim().slice(0, 50)}"`);
  });
  console.log(`\n== ${pagePath}\n${rows.join("\n")}`);
}

setUpHome();
await Promise.all([
  startDemoApp({ name: "storefront", remote: "git@github.com:acme/storefront.git", title: "Acme Storefront" }),
  startDemoApp({ name: "admin-dashboard", remote: "https://github.com/acme/admin-dashboard.git", title: "Acme Admin", branch: "feature/reports", dirty: true }),
]);
const port = await startPortal();
const base = `http://127.0.0.1:${port}`;

const { chromium } = require("@playwright/test");
const browser = await chromium.launch();
const context = await browser.newContext({ viewport: { width: 1200, height: 900 }, deviceScaleFactor: 2, colorScheme: "dark" });
await context.route("**/api/developer-runtime", async (route) => {
  const response = await route.fetch();
  await route.fulfill({ response, json: filterDeveloperRuntime(await response.json()) });
});
const page = await context.newPage();
page.setDefaultTimeout(20_000);

// Opens a page and waits for it to settle. Runtime discovers listeners asynchronously, so its
// page is refreshed until the demo apps appear.
async function openPage(pagePath) {
  log(`open ${pagePath}`);
  await page.goto(`${base}${pagePath}`, { waitUntil: "load" });
  // Every portal page shares a loading overlay that is hidden once its first data fetch resolves.
  await page.waitForSelector("#page-loading.hidden", { state: "attached", timeout: 120_000 }).catch(() => {});
  await page.waitForTimeout(1000);
  if (pagePath !== "/runtime") return;
  for (let i = 0; i < 6; i++) {
    if (await page.locator("text=storefront").count() && await page.locator("text=admin-dashboard").count()) {
      // Reload so the shot never catches a refresh spinner mid-animation.
      await page.reload({ waitUntil: "load" });
      await page.waitForSelector("#page-loading.hidden", { state: "attached", timeout: 120_000 }).catch(() => {});
      await page.waitForTimeout(1500);
      return;
    }
    log(`waiting for demo apps (${i + 1})`);
    await page.locator("#refresh").click({ timeout: 5000 }).catch(() => {});
    await page.waitForTimeout(1500);
  }
  const debugShot = path.join(os.tmpdir(), "docs-screenshots-runtime.png");
  await page.screenshot({ path: debugShot, fullPage: true }).catch(() => {});
  log(`page text:\n${(await page.locator("main").innerText().catch(() => "")).slice(0, 1500)}`);
  throw new Error(`demo apps never appeared on /runtime (see ${debugShot})`);
}

if (survey) {
  for (const pagePath of onlyPages ?? ["/", "/runtime", "/plans", "/config", "/tokens"]) {
    await openPage(pagePath);
    await surveyPage(page, pagePath);
    if (outIndex !== -1) {
      fs.mkdirSync(outDir, { recursive: true });
      await page.screenshot({ path: path.join(outDir, `preview-${pagePath.replace(/\//g, "") || "home"}.png`), fullPage: true });
    }
  }
  console.log("\n== CLI menu\n" + captureMenu().join("\n").replace(/\x1b\[[0-9;]*m/g, ""));
} else {
  fs.mkdirSync(outDir, { recursive: true });
  for (const shot of SHOTS.filter((candidate) => !onlyPages || onlyPages.includes(candidate.page))) {
    await openPage(shot.page);
    const file = path.join(outDir, shot.file);
    await captureShot(shot, file);
    console.log(`wrote ${path.relative(repoRoot, file)}`);
  }
  if (!onlyPages) {
    const menuHtml = ansiToHtml(captureMenu());
    await page.setContent(
      `<body style="margin:0;background:#0d1117"><pre id="term" style="margin:0;display:inline-block;padding:20px 28px;background:#0d1117;color:#d0d0d0;font:14px/1.45 ui-monospace,SFMono-Regular,Menlo,monospace">${menuHtml}</pre></body>`,
    );
    await page.locator("#term").screenshot({ path: path.join(outDir, "cli-menu.png") });
    console.log(`wrote ${path.relative(repoRoot, path.join(outDir, "cli-menu.png"))}`);
  }
}

await browser.close();
process.exit(0);
