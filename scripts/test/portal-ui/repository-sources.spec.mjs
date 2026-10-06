// Repository sources in the browser (docs/plans/active/portal-repository-sources.md §7): the
// first-run states on Home, Runtime, and Plans — Enable auto-discovery primary, Add a folder
// secondary, one call to action at a time — and the Manage repositories dialog against the real
// hermetic server, where auto-discovery starts off.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { test, expect } from "@playwright/test";

const ENABLE = "Enable auto-discovery of active repos";

test.describe("first-run repository states", () => {
  test("Home with nothing known and auto-discovery off: Enable is primary, Add a folder secondary", async ({ page }) => {
    await routeHome(page, { repositories: [], autoDiscovery: { enabled: false } });
    await page.goto("/");
    const empty = page.locator(".repository-empty-state");
    await expect(empty.getByRole("heading", { name: "No repositories yet" })).toBeVisible();
    await expect(empty.getByRole("button", { name: ENABLE })).toHaveAttribute("data-btn", "cta");
    await expect(empty.getByRole("button", { name: "Add a folder" })).toHaveAttribute("data-btn", "text");
    await expect(page.getByRole("button", { name: "Manage repositories" })).toBeHidden();
  });

  test("Home with nothing found yet and auto-discovery on drops the Enable action", async ({ page }) => {
    await routeHome(page, { repositories: [], autoDiscovery: { enabled: true } });
    await page.goto("/");
    const empty = page.locator(".repository-empty-state");
    await expect(empty).toContainText("Start a dev server in any repository and it appears here.");
    await expect(empty.getByRole("button", { name: ENABLE })).toHaveCount(0);
    await expect(empty.getByRole("button", { name: "Add a folder" })).toBeVisible();
  });

  test("Home with repositories known and auto-discovery off shows the compact prompt and Manage repositories", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator(".repository-card").first()).toBeVisible();
    await expect(page.locator(".auto-discovery-prompt").getByRole("button", { name: ENABLE })).toBeVisible();
    await expect(page.getByRole("button", { name: "Manage repositories" })).toBeVisible();
  });

  test("Runtime with auto-discovery off offers Enable, and Enable posts the consent", async ({ page }) => {
    await page.route("**/api/repositories/sources/auto-discovery/enabled", (route) => route.fulfill({
      json: { revision: 2, loadError: null, autoDiscovery: { id: "auto-discovery", enabled: true, repositoryCount: 0 }, sources: [], repositories: [] },
    }));
    await page.goto("/runtime");
    const cta = page.locator("#auto-discovery-cta");
    await expect(cta.getByRole("button", { name: ENABLE })).toBeVisible();
    const enable = page.waitForRequest((request) => request.url().endsWith("/api/repositories/sources/auto-discovery/enabled"));
    await cta.getByRole("button", { name: ENABLE }).click();
    expect((await enable).postDataJSON()).toEqual({ enabled: true });
  });

  for (const [step, scans, plans, title] of [
    ["no repositories", [], [], "No repositories yet"],
    ["repositories not scanned", [{ repositoryId: "local:aaaaaaaaaaaaaaaa", state: "unavailable", planCount: 0, checkoutCount: 0 }], [], "Not scanned yet: 1 repository"],
    ["no plans found", [{ repositoryId: "local:aaaaaaaaaaaaaaaa", state: "scanned", planCount: 0, checkoutCount: 1 }], [], "No plans found in 1 repository"],
  ]) {
    test(`Plans shows one call to action when ${step}`, async ({ page }) => {
      await page.route("**/api/plans", async (route) => {
        const data = await (await route.fetch()).json();
        await route.fulfill({ json: { ...data, plans, repositories: [], repositoryScans: scans, autoDiscovery: { enabled: false }, planWritePackage: { ...data.planWritePackage, available: true, enabled: true } } });
      });
      await page.goto("/plans");
      const onboarding = page.locator("#plans-onboarding");
      await expect(onboarding.getByRole("heading", { name: title })).toBeVisible();
      await expect(page.locator("#package-banner")).toBeHidden();
      await expect(page.locator("#groups")).toBeEmpty();
      if (step === "no repositories") {
        await expect(page.locator("#plans-header")).toBeHidden();
        await expect(onboarding.getByRole("button", { name: ENABLE })).toBeVisible();
        await expect(onboarding.getByRole("button", { name: "Add a folder" })).toBeVisible();
      } else {
        await expect(page.locator("#repos-count-text")).toContainText("1 Repo");
        await expect(onboarding.getByRole("button", { name: ENABLE })).toHaveCount(0);
        await onboarding.getByRole("button", { name: "Manage repositories…" }).click();
        await expect(page.locator("#repository-sources-dialog")).toBeVisible();
      }
    });
  }
});

test.describe("Manage repositories dialog", () => {
  let projects;
  test.beforeAll(() => {
    projects = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-sources-")));
    const repo = path.join(projects, "dialog-fixture");
    fs.mkdirSync(path.join(repo, "docs", "plans", "backlog"), { recursive: true });
    spawnSync("git", ["init", "-q", "-b", "main"], { cwd: repo });
  });
  test.afterAll(() => fs.rmSync(projects, { recursive: true, force: true }));

  test("adds a folder, explains how its repositories were found, ignores and restores one, and removes the folder", async ({ page }) => {
    await page.goto("/");
    await page.getByRole("button", { name: "Manage repositories" }).click();
    const dialog = page.locator("#repository-sources-dialog");
    await expect(dialog.getByRole("button", { name: ENABLE })).toBeVisible();

    await dialog.getByRole("button", { name: "Add a folder to find more repos" }).click();
    await dialog.getByLabel("Repository or folder of repositories").fill(projects);
    await dialog.getByRole("button", { name: "Add folder" }).click();
    const folder = dialog.locator("[data-slot=folders] li", { hasText: projects });
    await expect(folder).toContainText("Healthy");
    await expect(folder).toContainText("1 repo");
    const row = dialog.locator("[data-slot=repositories] li", { hasText: "dialog-fixture" });
    await expect(row).toContainText(`Found by: ${projects}`);

    await row.getByRole("button", { name: "Ignore repository" }).click();
    await expect(dialog.locator("[data-slot=repositories] li", { hasText: "dialog-fixture" })).toHaveCount(0);
    await dialog.getByText("Ignored (1)").click();
    await dialog.locator("[data-slot=ignored] li", { hasText: "dialog-fixture" }).getByRole("button", { name: "Restore" }).click();
    await expect(dialog.locator("[data-slot=repositories] li", { hasText: "dialog-fixture" })).toBeVisible();

    await folder.getByRole("button", { name: "Remove" }).click();
    await expect(dialog.locator("[data-slot=folders] li")).toHaveCount(0);
    await expect(dialog.locator("[data-slot=repositories] li", { hasText: "dialog-fixture" })).toContainText("No current source", { timeout: 5000 });
  });

  test("an unreadable path asks what it is before it is added", async ({ page }) => {
    const missing = path.join(projects, "not-there-yet");
    await page.goto("/");
    await page.getByRole("button", { name: "Manage repositories" }).click();
    const dialog = page.locator("#repository-sources-dialog");
    await dialog.getByRole("button", { name: "Add a folder to find more repos" }).click();
    await dialog.getByLabel("Repository or folder of repositories").fill(missing);
    await dialog.getByRole("button", { name: "Add folder" }).click();
    await expect(dialog.getByRole("group", { name: /can't read this path/ })).toBeVisible();
    const directoryIntent = dialog.getByLabel("A folder of repositories");
    await directoryIntent.check();
    await dialog.getByLabel("Repository or folder of repositories").fill(`${missing}-changed`);
    await expect(directoryIntent).not.toBeChecked();
    await dialog.getByLabel("Repository or folder of repositories").fill(missing);
    await dialog.getByRole("button", { name: "Add folder" }).click();
    await expect(dialog.getByRole("group", { name: /can't read this path/ })).toBeVisible();
    await directoryIntent.check();
    await dialog.getByRole("button", { name: "Add folder" }).click();
    const folder = dialog.locator("[data-slot=folders] li", { hasText: missing });
    await expect(folder).toContainText("Unavailable");
    await folder.getByRole("button", { name: "Remove" }).click();
    await expect(folder).toHaveCount(0);
  });

  test("keeps the title fixed while a tall dialog body scrolls and shows full paths on hover", async ({ page }) => {
    await page.setViewportSize({ width: 760, height: 800 });
    await routeRepositorySources(page, crowdedSourcesPayload());
    await page.goto("/");
    await page.getByRole("button", { name: "Manage repositories" }).click();

    const dialog = page.getByRole("dialog", { name: "Manage repositories" });
    const body = dialog.locator(".repository-sources-body");
    await expect.poll(() => body.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    const heading = dialog.getByRole("heading", { name: "Manage repositories" });
    const before = await heading.boundingBox();
    await body.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const after = await heading.boundingBox();
    expect(Math.abs(after.y - before.y)).toBeLessThan(1);

    const pathNode = dialog.locator("[data-slot=folders] [data-slot=path]").first();
    await expect(pathNode).toHaveAttribute("title", crowdedSourcesPayload().sources[0].displayPath);
    await expect(pathNode.locator(".sources-path-tail")).toHaveText("repository-with-a-distinctive-name");
  });

  test("keeps the close button visible and avoids horizontal overflow in a short narrow window", async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 560 });
    await routeRepositorySources(page, crowdedSourcesPayload());
    await page.goto("/");
    const initialTheme = await page.locator("html").getAttribute("data-theme");
    await page.getByRole("button", { name: "Toggle theme" }).click();
    await expect(page.locator("html")).not.toHaveAttribute("data-theme", initialTheme);
    await page.getByRole("button", { name: "Manage repositories" }).click();

    const dialog = page.getByRole("dialog", { name: "Manage repositories" });
    await expect.poll(() => dialog.evaluate((node) => node.scrollHeight > node.clientHeight)).toBe(true);
    await dialog.evaluate((node) => { node.scrollTop = node.scrollHeight; });
    const close = dialog.getByRole("button", { name: "Close" });
    await expect(close).toBeInViewport();
    expect(await dialog.evaluate((node) => node.scrollWidth <= node.clientWidth)).toBe(true);
    await expect(dialog).toBeVisible();
  });
});

// Serves the real /api/home response with its repository list and auto-discovery state replaced.
async function routeHome(page, overrides) {
  await page.route("**/api/home", async (route) => {
    const data = await (await route.fetch()).json();
    await route.fulfill({ json: { ...data, unresolvedActivity: [], ...overrides } });
  });
}

async function routeRepositorySources(page, payload) {
  await page.route("**/api/repositories/sources", (route) => {
    if (route.request().method() === "GET") return route.fulfill({ json: payload });
    return route.continue();
  });
}

function crowdedSourcesPayload() {
  const longPath = "~/projects/a-very-long-folder-name/another-long-folder/repository-with-a-distinctive-name";
  return {
    revision: 1,
    loadError: null,
    autoDiscovery: { id: "auto-discovery", enabled: false, repositoryCount: 0 },
    repositories: Array.from({ length: 10 }, (_, index) => ({
      repositoryId: `local:${String(index).padStart(16, "0")}`,
      displayName: `repository-${index + 1}`,
      visibility: "visible",
      pinned: false,
      foundBy: [longPath],
    })),
    sources: Array.from({ length: 10 }, (_, index) => ({
      id: `src-${String(index).padStart(8, "0")}`,
      kind: "directory",
      displayPath: index === 0 ? longPath : `~/projects/source-${index + 1}`,
      enabled: true,
      status: { state: "healthy", repositoryCount: 1, message: null },
    })),
  };
}
