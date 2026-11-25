// Package sources and installs on the Agents page, against the real hermetic server, alternating
// with `roborepo package ...` on the same state root: each step one surface takes shows in the
// other. One lifecycle: add a folder source (portal) and a GitHub source (CLI, a file:// fixture),
// an install refused because its plan changed after the preview, a confirmed install, enable, a new
// upstream commit, refresh, update, remove, and removing both sources.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";
import { test, expect } from "@playwright/test";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..", "..");
const cliEnv = JSON.parse(process.env.PORTAL_UI_CLI_ENV || "null");
let tmp;

function cli(...args) {
  const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), ...args], { env: { ...process.env, ...cliEnv }, encoding: "utf8" });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

function cliJson(...args) {
  const result = cli(...args, "--json");
  expect(result.status, result.stderr).toBe(0);
  return JSON.parse(result.stdout);
}

function fixtureGit(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  expect(result.status, result.stderr).toBe(0);
  return result.stdout.trim();
}

const manifest = (id, label) => JSON.stringify({
  schemaVersion: 1,
  id,
  label,
  description: `${label} fixture.`,
  presentation: { category: "integrations" },
  resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
});

function commit(dir, files) {
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), content);
  }
  fixtureGit(dir, "add", "-A");
  fixtureGit(dir, "commit", "-q", "-m", "fixture");
  return fixtureGit(dir, "rev-parse", "HEAD");
}

const listed = (id) => cliJson("package", "list").packages.find((row) => row.id === id);
const sourceRow = (page, id) => page.locator(`.source-row[data-source-id="${id}"]`);
const card = (page, label) => page.locator(".item").filter({ has: page.locator(".item-label", { hasText: label }) });
const dialog = (page) => page.locator("#package-action-modal");

test.beforeAll(() => {
  test.skip(!cliEnv, "needs PORTAL_UI_CLI_ENV from run.mjs");
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-packages-"));
});

test.afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

test("package sources and installs agree between the portal and the CLI", async ({ page }) => {
  test.setTimeout(120_000);
  const folder = path.join(tmp, "ui-folder");
  fs.mkdirSync(path.join(folder, "uifolderpkg"), { recursive: true });
  fs.writeFileSync(path.join(folder, "uifolderpkg", "package.config.json"), manifest("uifolderpkg", "UI Folder Pkg"));
  fs.writeFileSync(path.join(folder, "uifolderpkg", "rules.md"), "## UI folder pkg\n");
  const repo = path.join(tmp, "ui-team");
  fs.mkdirSync(repo, { recursive: true });
  fixtureGit(repo, "init", "-q");
  const first = commit(repo, { "packages/uitool/package.config.json": manifest("uitool", "UI Tool"), "packages/uitool/rules.md": "## UI tool v1\n" });

  // Portal: add the folder source. The CLI lists it.
  await page.goto("/agents");
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible();
  await page.getByRole("button", { name: "Add a Source" }).click();
  await page.getByLabel("GitHub URL or folder path").fill(folder);
  await page.getByLabel("Id (optional)").fill("uifolder");
  await page.getByRole("button", { name: "Add Source", exact: true }).click();
  await expect(sourceRow(page, "uifolder")).toBeVisible();
  await expect(page.locator(".sources-status")).toContainText("Added uifolder: 1 package available.");
  expect(cliJson("package", "source", "list").map((source) => source.id)).toContain("uifolder");

  // CLI: add the GitHub source. The portal shows it after a reload, with its package on Third Party.
  expect(cli("package", "source", "add", pathToFileURL(repo).href, "--id", "uiteam").status).toBe(0);
  await page.reload();
  await expect(sourceRow(page, "uiteam")).toBeVisible();
  await page.getByRole("tab", { name: /Third Party/ }).click();
  const tool = card(page, "UI Tool");
  await expect(tool.getByRole("button", { name: "Install UI Tool" })).toBeVisible();
  await expect(tool.getByRole("checkbox")).toHaveCount(0);

  // Portal: the install preview names the first commit. The source moves (CLI) before confirming,
  // so the install is refused and the dialog shows the new commit; confirming again installs it.
  await tool.getByRole("button", { name: "Install UI Tool" }).click();
  await expect(dialog(page)).toContainText(`commit ${first.slice(0, 12)}`);
  await expect(dialog(page)).toContainText("This repository is not in RoboRepo's trusted catalog.");
  const second = commit(repo, { "packages/uitool/rules.md": "## UI tool v2\n" });
  expect(cli("package", "source", "refresh", "uiteam").status).toBe(0);
  await dialog(page).getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog(page)).toContainText("changed since it was shown");
  await expect(dialog(page)).toContainText(`commit ${second.slice(0, 12)}`);
  await dialog(page).getByRole("button", { name: "Install", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(listed("uitool")).toMatchObject({ installed: true, active: false, revision: second });

  // Portal: turn it on. The CLI sees it active. The hermetic machine has no harness installed, so
  // nothing reaches harness files here; portal-package-routes-check.mjs asserts the re-apply.
  await expect(tool.locator(".item-revision")).toHaveText(`@ ${second.slice(0, 12)}`);
  // The switch's input is visually hidden behind its track, as on every Agents row.
  await tool.getByRole("checkbox", { name: "UI Tool" }).dispatchEvent("click");
  await expect.poll(() => listed("uitool").active).toBe(true);

  // CLI: a new upstream commit and a refresh. The portal offers Update; confirming re-applies it.
  const third = commit(repo, { "packages/uitool/rules.md": "## UI tool v3\n" });
  expect(cli("package", "source", "refresh", "uiteam").status).toBe(0);
  await page.reload();
  await tool.getByRole("button", { name: "Update UI Tool" }).click();
  await expect(dialog(page)).toContainText(`${second.slice(0, 12)} → ${third.slice(0, 12)}`);
  await expect(dialog(page)).toContainText("rules.md");
  await dialog(page).getByRole("button", { name: "Update", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(listed("uitool")).toMatchObject({ revision: third, active: true });

  // Portal: remove it. The CLI sees it gone; the source still offers it, so the card offers Install.
  await tool.getByRole("button", { name: "Remove UI Tool" }).click();
  await expect(dialog(page)).toContainText("Its installed copy is then deleted.");
  await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(tool.getByRole("button", { name: "Install UI Tool" })).toBeVisible();
  expect(listed("uitool")).toMatchObject({ installed: false, active: false });

  // The folder's package is on Custom with its switch: a folder package is used in place, so its
  // switch installs it, as `roborepo package enable` does, and it has no Install.
  await page.getByRole("tab", { name: /Custom/ }).click();
  const folderCard = card(page, "UI Folder Pkg");
  await expect(folderCard.getByRole("checkbox", { name: "UI Folder Pkg" })).toHaveCount(1);
  await expect(folderCard.getByRole("button", { name: "Install UI Folder Pkg" })).toHaveCount(0);

  // Portal: turn the folder package on, then remove it from its card. It is turned off first and
  // its folder stays.
  await folderCard.getByRole("checkbox", { name: "UI Folder Pkg" }).dispatchEvent("click");
  await expect.poll(() => listed("uifolderpkg")?.active).toBe(true);
  await folderCard.getByRole("button", { name: "Remove UI Folder Pkg" }).click();
  await expect(dialog(page)).toContainText("Its folder is left as it is");
  await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  expect(listed("uifolderpkg")).toMatchObject({ installed: false, active: false });
  expect(fs.existsSync(path.join(folder, "uifolderpkg", "package.config.json"))).toBe(true);

  // Portal: add a second GitHub source, refresh it after a new commit, and remove it keeping the
  // package the CLI installed from it.
  const extra = path.join(tmp, "ui-extra");
  fs.mkdirSync(extra, { recursive: true });
  fixtureGit(extra, "init", "-q");
  commit(extra, { "packages/uiextra/package.config.json": manifest("uiextra", "UI Extra"), "packages/uiextra/rules.md": "## UI extra v1\n" });
  await page.getByRole("button", { name: "Add a Source" }).click();
  await page.getByLabel("GitHub URL or folder path").fill(pathToFileURL(extra).href);
  await page.getByLabel("Id (optional)").fill("uiextra");
  await page.getByRole("button", { name: "Add Source", exact: true }).click();
  await expect(page.locator(".sources-status")).toContainText("Added uiextra: 1 package available.");
  await expect(page.locator(".sources-status")).toContainText("This repository is not in RoboRepo's trusted catalog.");
  expect(cliJson("package", "source", "list").map((source) => source.id)).toContain("uiextra");
  const extraSecond = commit(extra, { "packages/uiextra/rules.md": "## UI extra v2\n" });
  await sourceRow(page, "uiextra").getByRole("button", { name: "Refresh uiextra" }).click();
  await expect(page.locator(".sources-status")).toHaveText(`uiextra is now at ${extraSecond.slice(0, 12)}.`);
  expect(cliJson("package", "source", "list").find((source) => source.id === "uiextra").revision).toBe(extraSecond);
  expect(cli("package", "install", "uiextra/uiextra", "--yes").status).toBe(0);
  await page.reload();
  await sourceRow(page, "uiextra").getByRole("button", { name: "Remove uiextra" }).click();
  await dialog(page).getByLabel("Keep its installed packages, usable without a source").check();
  await dialog(page).getByRole("button", { name: "Remove Source" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(sourceRow(page, "uiextra")).toHaveCount(0);
  expect(listed("uiextra")).toMatchObject({ installed: true, available: false });
  expect(cli("package", "remove", "uiextra").status).toBe(0);

  // CLI: remove the GitHub source. Portal: remove the folder source. Each shows in the other.
  expect(cli("package", "source", "remove", "uiteam").status).toBe(0);
  await page.reload();
  await expect(sourceRow(page, "uiteam")).toHaveCount(0);
  await sourceRow(page, "uifolder").getByRole("button", { name: "Remove uifolder" }).click();
  await dialog(page).getByRole("button", { name: "Remove Source" }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(sourceRow(page, "uifolder")).toHaveCount(0);
  expect(cliJson("package", "source", "list").map((source) => source.id).sort()).toEqual(["builtin", "local"]);
  expect(fs.existsSync(path.join(folder, "uifolderpkg", "package.config.json"))).toBe(true);
});

// Each card state from the package view, seeded through the CLI: no longer offered, its source
// repointed, can't be found (with Remove), and hidden by a workspace override.
test("cards show each state the package view reports", async ({ page }) => {
  test.setTimeout(120_000);
  const repoFor = (name, files) => {
    const dir = path.join(tmp, name);
    fs.mkdirSync(dir, { recursive: true });
    fixtureGit(dir, "init", "-q");
    commit(dir, files);
    return dir;
  };
  const pkgFiles = (id, label) => ({ [`packages/${id}/package.config.json`]: manifest(id, label), [`packages/${id}/rules.md`]: `## ${label}\n` });
  const ok = (...args) => {
    const result = cli(...args);
    expect(result.status, `${args.join(" ")}\n${result.stderr}`).toBe(0);
  };

  // No longer offered: installed, then the source's next commit drops it.
  const dropping = repoFor("st-drop", { ...pkgFiles("stdropped", "St Dropped"), ...pkgFiles("stkept", "St Kept") });
  ok("package", "source", "add", pathToFileURL(dropping).href, "--id", "stdrop");
  ok("package", "install", "stdrop/stdropped", "--yes");
  fs.rmSync(path.join(dropping, "packages", "stdropped"), { recursive: true });
  fixtureGit(dropping, "add", "-A");
  fixtureGit(dropping, "commit", "-q", "-m", "drop");
  ok("package", "source", "refresh", "stdrop");

  // Source repointed: installed from one repo, then the source record names another that offers the
  // same package.
  const first = repoFor("st-first", pkgFiles("stmoved", "St Moved"));
  const second = repoFor("st-second", pkgFiles("stmoved", "St Moved"));
  ok("package", "source", "add", pathToFileURL(first).href, "--id", "stmove");
  ok("package", "install", "stmove/stmoved", "--yes");
  const sourcesFile = path.join(cliEnv.ROBOREPO_STATE_ROOT, "package-sources.json");
  const config = JSON.parse(fs.readFileSync(sourcesFile, "utf8"));
  config.sources = config.sources.map((source) => (source.id === "stmove" ? { ...source, url: pathToFileURL(second).href } : source));
  fs.writeFileSync(sourcesFile, JSON.stringify(config, null, 2));
  ok("package", "source", "refresh", "stmove");

  // Can't be found: a folder package installed, then its folder deleted.
  const folder = path.join(tmp, "st-folder");
  fs.mkdirSync(path.join(folder, "stgone"), { recursive: true });
  fs.writeFileSync(path.join(folder, "stgone", "package.config.json"), manifest("stgone", "St Gone"));
  fs.writeFileSync(path.join(folder, "stgone", "rules.md"), "## St gone\n");
  ok("package", "source", "add", folder, "--id", "stfolder");
  ok("package", "install", "stfolder/stgone", "--yes");
  fs.rmSync(path.join(folder, "stgone"), { recursive: true });

  // Hidden: a workspace package with the same id as an installed GitHub copy. The install record
  // keeps the GitHub copy in use, so the workspace one is shadowed.
  const shadowRepo = repoFor("st-shadow", pkgFiles("stshadow", "St Shadow"));
  ok("package", "source", "add", pathToFileURL(shadowRepo).href, "--id", "stshade");
  ok("package", "install", "stshade/stshadow", "--yes");
  const workspacePackages = cliJson("package", "source", "info", "local").location;
  fs.mkdirSync(path.join(workspacePackages, "stshadow"), { recursive: true });
  fs.writeFileSync(path.join(workspacePackages, "stshadow", "package.config.json"), manifest("stshadow", "St Shadow Local"));
  fs.writeFileSync(path.join(workspacePackages, "stshadow", "rules.md"), "## St shadow local\n");

  try {
    await page.goto("/agents");
    await page.getByRole("tab", { name: /Third Party/ }).click();
    await expect(card(page, "St Dropped").locator(".package-state-note")).toHaveText("No longer offered by its source");
    await expect(card(page, "St Moved").locator(".package-state-note")).toHaveText("Its source now points at a different repo");
    await expect(card(page, "St Moved").getByRole("button", { name: "Update St Moved" })).toHaveCount(0);

    // A preview that returns after Cancel does not reopen the dialog.
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    let previewAnswered;
    const answered = new Promise((resolve) => { previewAnswered = resolve; });
    await page.route("**/api/packages/install-preview**", async (route) => {
      await held;
      await route.continue();
      previewAnswered();
    });
    await card(page, "St Kept").getByRole("button", { name: "Install St Kept" }).click();
    await expect(dialog(page)).toContainText("Reading what it would install");
    await dialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(dialog(page)).toBeHidden();
    release();
    await answered;
    await page.waitForTimeout(300);
    await expect(dialog(page)).toBeHidden();
    await page.unroute("**/api/packages/install-preview**");

    await page.getByRole("tab", { name: /Custom/ }).click();
    await expect(card(page, "local/stshadow").locator(".package-state-note")).toHaveText("Hidden by stshade/stshadow");
    const gone = card(page, "stfolder/stgone");
    await expect(gone.locator(".package-state-note")).toContainText("Can't be found: ");
    await gone.getByRole("button", { name: "Remove stfolder/stgone" }).click();
    // Its source is a folder, so the dialog says its files stay.
    await expect(dialog(page)).toContainText("Its folder is left as it is");
    await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
    await expect(dialog(page)).toBeHidden();
    await expect(gone).toHaveCount(0);
    expect(cliJson("package", "list").unresolved.some((entry) => entry.id === "stgone")).toBe(false);
  } finally {
    // Leave the shared hermetic machine as it was for later specs.
    fs.rmSync(path.join(workspacePackages, "stshadow"), { recursive: true, force: true });
    for (const id of ["stdropped", "stmoved", "stshadow", "stgone"]) cli("package", "remove", id);
    for (const id of ["stdrop", "stmove", "stfolder", "stshade"]) cli("package", "source", "remove", id, "--keep-installed");
  }
});

test("a refused source action shows the package service's message", async ({ page }) => {
  await page.goto("/agents");
  await page.getByRole("button", { name: "Add a Source" }).click();
  await page.getByLabel("GitHub URL or folder path").fill("not a repo or folder");
  await page.getByRole("button", { name: "Add Source", exact: true }).click();
  const expected = cli("package", "source", "add", "not a repo or folder").stderr.trim();
  expect(expected).not.toBe("");
  await expect(page.locator(".sources-status")).toHaveText(expected);
});

test("package tabs and sources stay out of a single-repo scope", async ({ page }) => {
  await page.goto("/agents");
  await expect(page.getByRole("tablist", { name: "Package sources" })).toBeVisible();
  await page.goto("/agents?repo=roborepo");
  // The scoped view rendered (the seeded repo has no readable checkout), so an absent tab list
  // means the scope left it out, not that nothing drew.
  await expect(page.getByText("Primary checkout unavailable")).toBeVisible();
  await expect(page.getByRole("tablist", { name: "Package sources" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sources" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Install / })).toHaveCount(0);

  // Back to All repos through the selector: the tabs and sources return without waiting for a poll.
  await page.getByRole("button", { name: /^Repo: / }).click();
  await page.getByRole("option", { name: "All repos", exact: true }).click();
  await expect(page.getByRole("tablist", { name: "Package sources" })).toBeVisible({ timeout: 3_000 });
  await expect(page.getByRole("heading", { name: "Sources" })).toBeVisible({ timeout: 3_000 });
});
