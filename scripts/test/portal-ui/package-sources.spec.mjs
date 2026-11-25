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
  await dialog(page).getByRole("button", { name: "Remove", exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(tool.getByRole("button", { name: "Install UI Tool" })).toBeVisible();
  expect(listed("uitool")).toMatchObject({ installed: false, active: false });

  // The folder's package is on Custom, offered to install.
  await page.getByRole("tab", { name: /Custom/ }).click();
  await expect(card(page, "UI Folder Pkg").getByRole("button", { name: "Install UI Folder Pkg" })).toBeVisible();

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
  await page.waitForLoadState("networkidle");
  await expect(page.getByRole("tablist", { name: "Package sources" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Sources" })).toHaveCount(0);
  await expect(page.getByRole("button", { name: /^Install / })).toHaveCount(0);
});
