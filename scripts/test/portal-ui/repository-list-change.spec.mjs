// A change in the Manage Repos dialog reaches the page behind it without a reload: the header
// selector lists the new set, a selected repo that is no longer listed falls back to All repos, and
// a repo that left takes its plans with it. Each test registers its own throwaway repositories, since
// ignoring one is stored in the shared registry and would leak into later specs.
import crypto from "node:crypto";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createPlanFixture } from "../lib/plan-git-fixture.mjs";
import { addRepositorySource, enablePlanBoard, portalToken, removeFixtureContents, removeRepositorySources } from "./helpers.mjs";

let fx;
let names;
test.beforeAll(() => {
  fx = createPlanFixture("portal-ui-repo-change-");
});

// Lowercase hex keeps each folder name equal to its urlKey.
function planRepository(label) {
  const name = `${label.toLowerCase()}-${crypto.randomBytes(3).toString("hex")}`;
  fx.repository(name, {
    "plans/active/only.md": ["---", `id: ${name}-only`, "next_action: Check the list", "---", "", `# ${label} plan`, "", "## Summary", "", "Repo list fixture.", ""].join("\n"),
  });
  return name;
}

test.beforeEach(async ({ page }) => {
  names = { alpha: planRepository("Alpha"), beta: planRepository("Beta"), gamma: planRepository("Gamma") };
  for (const name of [names.alpha, names.beta]) await addRepositorySource(page, path.join(fx.tmp, name));
  await enablePlanBoard(page);
});

// Ignored repositories stay ignored in the registry, so restore every one a test ignored. Removing a
// source keeps the repositories it found, so the test's folders go too, which drops them from the list.
test.afterEach(async ({ page }) => {
  const token = await portalToken(page);
  const { repositories } = await (await page.request.get("/api/repositories/sources")).json();
  for (const repository of repositories.filter((candidate) => candidate.visibility === "hidden")) {
    await page.request.post("/api/developer-runtime/repository-visibility", {
      headers: { "X-Cli-Portal-Token": token },
      data: { repositoryId: repository.repositoryId, hidden: false },
    });
  }
  await removeRepositorySources(page);
  removeFixtureContents(fx);
});

const selector = (page) => page.getByRole("button", { name: /^Repo: / });
const dialog = (page) => page.locator("#repository-sources-dialog");

async function openManageRepos(page, { menuOpen = false } = {}) {
  if (!menuOpen) await selector(page).click();
  await page.getByRole("button", { name: "Manage Repos" }).click();
  await expect(dialog(page)).toBeVisible();
}

async function ignoreInDialog(page, name) {
  await dialog(page).locator("[data-slot=repositories] li", { hasText: name }).getByRole("button", { name: "Ignore Repo" }).click();
  await expect(dialog(page).locator("[data-slot=repositories] li", { hasText: name })).toHaveCount(0);
}

test("ignoring the selected repo returns Plans to All repos and keeps the other parameters", async ({ page }) => {
  await page.goto(`/plans?lifecycle=active&repo=${names.alpha}`);
  await expect(page.getByText("Alpha plan")).toBeVisible();
  await expect(page.getByText("Beta plan")).toHaveCount(0);

  await openManageRepos(page);
  await ignoreInDialog(page, names.alpha);
  await expect(page).toHaveURL(/\/plans\?lifecycle=active$/);
  await page.keyboard.press("Escape");

  await expect(selector(page)).toHaveAccessibleName("Repo: All repos");
  await expect(page.getByText("Beta plan")).toBeVisible();
  await expect(page.getByText("Alpha plan")).toHaveCount(0);
  await selector(page).click();
  await expect(page.getByRole("option", { name: names.alpha })).toHaveCount(0);
});

test("ignoring another repo drops its plans and its selector option and leaves the scope alone", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha plan")).toBeVisible();
  await expect(page.getByText("Beta plan")).toBeVisible();

  await openManageRepos(page);
  await ignoreInDialog(page, names.beta);
  await expect(page.getByText("Beta plan")).toHaveCount(0);
  await page.keyboard.press("Escape");

  await expect(page).toHaveURL(/\/plans$/);
  await expect(page.getByText("Alpha plan")).toBeVisible();
  await selector(page).click();
  await expect(page.getByRole("option", { name: names.alpha })).toBeVisible();
  await expect(page.getByRole("option", { name: names.beta })).toHaveCount(0);
});

test("a repo added in Manage Repos shows in the selector and on the board without a reload", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha plan")).toBeVisible();
  await selector(page).click();
  await expect(page.getByRole("option", { name: names.gamma })).toHaveCount(0);

  await openManageRepos(page, { menuOpen: true });
  await dialog(page).getByRole("button", { name: "Find more repos" }).click();
  await dialog(page).getByLabel("Find more repos in").fill(path.join(fx.tmp, names.gamma));
  await dialog(page).getByRole("button", { name: "Add folder" }).click();
  await expect(dialog(page).locator("[data-slot=repositories] li", { hasText: names.gamma })).toBeVisible();
  await page.keyboard.press("Escape");

  await expect(page.getByText("Gamma plan")).toBeVisible();
  await selector(page).click();
  await expect(page.getByRole("option", { name: names.gamma })).toBeVisible();
});

test("ignoring the selected repo on Agents returns it to All repos", async ({ page }) => {
  await page.goto(`/agents?repo=${names.alpha}`);
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${names.alpha}`);
  await expect(page.getByRole("heading", { name: `Token Use for ${names.alpha}` })).toBeVisible();

  await openManageRepos(page);
  await ignoreInDialog(page, names.alpha);
  await expect(page).toHaveURL(/\/agents$/);
  await page.keyboard.press("Escape");
  await expect(selector(page)).toHaveAccessibleName("Repo: All repos");
  await expect(page.getByRole("button", { name: "Show all repos" })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: /^Token Use for / })).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
});

test("ignoring another repo keeps Agents on the selected repo and re-reads its config", async ({ page }) => {
  await page.goto(`/agents?repo=${names.alpha}`);
  await expect(page.getByRole("heading", { name: `Token Use for ${names.alpha}` })).toBeVisible();

  await openManageRepos(page);
  const reread = page.waitForRequest((request) => {
    const url = new URL(request.url());
    return url.pathname === "/api/config/repository" && url.searchParams.get("repo") === names.alpha;
  });
  await ignoreInDialog(page, names.beta);
  await reread;
  await page.keyboard.press("Escape");
  await expect(page).toHaveURL(new RegExp(`/agents\\?repo=${names.alpha}$`));
  await expect(page.getByRole("heading", { name: `Token Use for ${names.alpha}` })).toBeVisible();
});

// Ignoring a repo can move its sessions out of the report without changing the report's version, so
// Tokens must refetch rather than wait for a version change. The report does not repaint under an
// open dialog, so the new numbers show once Manage Repos closes.
test("Tokens re-reads its report after a repo change, even when the report version is unchanged", async ({ page }) => {
  const demo = await (await page.request.get("/api/tokens/mock")).json();
  const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed" };
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    telemetry: { enabled: true, captureAvailable: true },
    harnesses: { supported: [claude], detected: [claude], active: [claude] },
  } }));
  let changed = false;
  await page.route((url) => url.pathname === "/api/data", (route) => route.fulfill({
    json: { ...demo, version: "fixed", capture_count: 1, event_count: changed ? 222 : 111 },
  }));
  await page.goto("/tokens");
  await expect(page.locator("#tokensmeta")).toContainText("111 events recorded");

  await openManageRepos(page);
  changed = true;
  await ignoreInDialog(page, names.beta);
  await page.keyboard.press("Escape");
  await expect(page.locator("#tokensmeta")).toContainText("222 events recorded", { timeout: 2000 });
});
