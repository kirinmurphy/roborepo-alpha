// The shared repository scope in the browser: the selector's sub-header row, `?repository=` surviving
// navigation between Plans, Tokens, and Agents (and dropping for the rest), browser history, the
// unavailable state, Tokens' Activity outside listed repos, the scoped Agents splash, the Manage
// repositories action row, and Home's scoped Token Warnings link. Two throwaway repositories with
// real plan files run through the real hermetic server.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addRepositorySource, patchHomeOverview, removeRepositorySources, roboRepoCard } from "./helpers.mjs";

// Unique per worker: a retried worker registers fresh folders, and removing a source never forgets
// the repositories it found, so fixed names would collide with the previous worker's records.
// Lowercase hex keeps each folder name equal to its urlKey.
let ALPHA;
let BETA;
let fixtureRoot;
test.beforeAll(() => {
  const suffix = crypto.randomBytes(3).toString("hex");
  ALPHA = `alpha-${suffix}`;
  BETA = `beta-${suffix}`;
  fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-scope-"));
  for (const [name, title] of [[ALPHA, "Alpha"], [BETA, "Beta"]]) {
    const repo = path.join(fixtureRoot, name);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(repo, "docs", "plans", "active"), { recursive: true });
    for (const priority of ["high", "low"]) {
      fs.writeFileSync(path.join(repo, "docs", "plans", "active", `${priority}.md`), [
        "---", `id: ${name}-${priority}`, `priority: ${priority}`, "next_action: Check the scope", "---", "",
        `# ${title} ${priority} plan`, "", "## Summary", "", "Scope fixture.", "",
      ].join("\n"));
    }
  }
});
test.afterAll(() => fs.rmSync(fixtureRoot, { recursive: true, force: true }));
test.beforeEach(async ({ page }) => {
  for (const name of [ALPHA, BETA]) await addRepositorySource(page, path.join(fixtureRoot, name));
  // The board only shows once plan-write is enabled; the hermetic machine has no packages. Matched
  // by path so scoped requests (?repository=) are patched too.
  await page.route((url) => url.pathname === "/api/plans", async (route) => {
    // An unavailable scope's 404 passes through with its status.
    const response = await route.fetch();
    const data = await response.json();
    if (data.planWritePackage) data.planWritePackage = { ...data.planWritePackage, available: true, enabled: true };
    await route.fulfill({ response, json: data });
  });
});
test.afterEach(async ({ page }) => removeRepositorySources(page));

const selector = (page) => page.getByRole("button", { name: /^Repository: / });
const scopeParam = (page) => new URL(page.url()).searchParams.get("repository");

async function chooseScope(page, label) {
  await selector(page).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test("the selector has its own full-width row below the site header, its content in the page column", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/plans");
  await expect(selector(page)).toBeVisible();
  await expect(page.locator(".portal-header").getByRole("button", { name: /^Repository: / })).toHaveCount(0);
  const bar = page.locator(".repository-scope-bar");
  await expect(bar).toHaveCount(1);
  const layout = await bar.evaluate((node) => {
    const header = document.querySelector(".portal-header").getBoundingClientRect();
    const row = node.getBoundingClientRect();
    const column = node.querySelector(".inner").getBoundingClientRect();
    const pageColumn = document.querySelector("main.inner, #main, main")?.getBoundingClientRect();
    return {
      belowHeader: row.top >= header.bottom - 1,
      fullWidth: Math.round(row.width) === document.documentElement.clientWidth,
      columnWidth: Math.round(column.width),
      ownBackground: getComputedStyle(node).backgroundColor !== getComputedStyle(document.body).backgroundColor,
      alignedWithPage: pageColumn ? Math.abs(column.left - pageColumn.left) < 1 : true,
    };
  });
  expect(layout).toEqual({ belowHeader: true, fullWidth: true, columnWidth: 1024, ownBackground: true, alignedWithPage: true });
});

test("the scope travels between Plans, Tokens, and Agents and drops for Runtime, Settings, and Home", async ({ page }) => {
  await page.goto(`/plans?repository=${ALPHA}`);
  await expect(selector(page)).toHaveAccessibleName(`Repository: ${ALPHA}`);
  const nav = page.locator("#nav");
  await expect(nav.locator("> a", { hasText: "Agents" })).toHaveAttribute("href", `/agents?repository=${ALPHA}`);
  await expect(nav.locator("> a", { hasText: "Tokens" })).toHaveAttribute("href", `/tokens?repository=${ALPHA}`);
  await expect(nav.locator("> a", { hasText: "Repos" })).toHaveAttribute("href", "/");
  await expect(page.locator(".portal-logo a")).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "More pages" }).click();
  const menu = page.locator("#nav-more-panel");
  await expect(menu.getByRole("link", { name: "Runtime" })).toHaveAttribute("href", "/runtime");
  await expect(menu.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  await page.keyboard.press("Escape");

  await nav.locator("> a", { hasText: "Tokens" }).click();
  await expect(page).toHaveURL(new RegExp(`/tokens\\?repository=${ALPHA}$`));
  await expect(selector(page)).toHaveAccessibleName(`Repository: ${ALPHA}`);
  await page.locator("#nav > a", { hasText: "Agents" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents\\?repository=${ALPHA}$`));
  await page.getByRole("button", { name: "More pages" }).click();
  await page.locator("#nav-more-panel").getByRole("link", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/\/runtime$/);
  await expect(selector(page)).toHaveCount(0);
});

test("changing the scope keeps Plans filters, and back, forward, and deep links restore it", async ({ page }) => {
  await page.goto(`/plans?repository=${ALPHA}`);
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.locator("#priority").selectOption("high");
  await expect(page.getByText("Alpha low plan")).toHaveCount(0);

  await chooseScope(page, BETA);
  await expect(page).toHaveURL(new RegExp(`/plans\\?repository=${BETA}$`));
  await expect(page.getByText("Beta high plan")).toBeVisible();
  await expect(page.getByText("Beta low plan")).toHaveCount(0);
  await expect(page.getByText("Alpha high plan")).toHaveCount(0);
  await expect(page.locator("#priority")).toHaveValue("high");

  await page.goBack();
  expect(scopeParam(page)).toBe(ALPHA);
  await expect(selector(page)).toHaveAccessibleName(`Repository: ${ALPHA}`);
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toHaveCount(0);
  await page.goForward();
  expect(scopeParam(page)).toBe(BETA);
  await expect(page.getByText("Beta high plan")).toBeVisible();

  await chooseScope(page, "All repositories");
  expect(scopeParam(page)).toBeNull();
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toBeVisible();
});

test("an unavailable scope never shows all repositories and clears to All with page state kept", async ({ page }) => {
  await page.goto("/plans?repository=no-such-repo&lifecycle=active");
  await expect(page.getByRole("heading", { name: "Repository unavailable" })).toBeVisible();
  await expect(selector(page)).toHaveAccessibleName("Repository: Unavailable repository");
  await expect(page.getByText("Alpha high plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all repositories" }).click();
  await expect(page).toHaveURL(/\/plans\?lifecycle=active$/);
  await expect(page.getByText("Alpha high plan")).toBeVisible();

  await page.goto("/agents?repository=no-such-repo");
  await expect(page.getByRole("heading", { name: "Repository unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toHaveCount(0);

  // The hermetic machine shows Tokens' demo report, which no route resolves; the selector decides.
  await page.goto("/tokens?repository=no-such-repo");
  await expect(page.getByRole("heading", { name: "Repository unavailable" })).toBeVisible();
  await expect(page.locator("#tokenscontent")).toBeHidden();
});

test("Activity outside listed repos is a Tokens-only scope", async ({ page }) => {
  await page.goto("/plans");
  await selector(page).click();
  await expect(page.getByRole("option", { name: "Activity outside listed repos" })).toHaveCount(0);

  await page.goto("/tokens");
  await chooseScope(page, "Activity outside listed repos");
  expect(scopeParam(page)).toBe("_other");
  // The hermetic machine shows the demo report, which no scope filters; the page says so.
  await expect(page.getByText("It is not filtered by the selected repository.")).toBeVisible();
  await expect(page.locator("#nav > a", { hasText: "Plans" })).toHaveAttribute("href", "/plans");
  await page.locator("#nav > a", { hasText: "Plans" }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(selector(page)).toHaveAccessibleName("Repository: All repositories");
});

test("scoped Agents is a coming-soon splash, and Remove filter returns to global Agents", async ({ page }) => {
  await page.goto(`/agents?repository=${ALPHA}`);
  const splash = page.locator(".agents-repository-splash");
  await expect(splash.getByRole("heading", { name: "Repository-level agent config is coming soon" })).toBeVisible();
  await expect(splash).toContainText(`Rules, hooks, and skills for ${ALPHA}.`);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toHaveCount(0);

  await splash.getByRole("button", { name: "Remove filter" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
  await expect(selector(page)).toHaveAccessibleName("Repository: All repositories");
});

test("Manage repositories… opens the dialog without changing the selected repository", async ({ page }) => {
  await page.goto(`/agents?repository=${ALPHA}`);
  await selector(page).click();
  await expect(page.getByRole("option", { name: "Manage repositories…" })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage repositories…" }).click();
  await expect(page.locator("dialog#repository-sources-dialog")).toBeVisible();
  expect(scopeParam(page)).toBe(ALPHA);
  await page.keyboard.press("Escape");
  await expect(selector(page)).toHaveAccessibleName(`Repository: ${ALPHA}`);
});

test("Home's Token Warnings link opens Tokens scoped to that repository", async ({ page }) => {
  await patchHomeOverview(page, (data) => {
    const repository = data.repositories.find((candidate) => candidate.displayName === "RoboRepo");
    repository.domains.tokens = { status: "available", data: {
      warningCount: 1,
      warnings: [{ kind: "spike", model: "gpt-5-codex", at: "2026-09-24T12:00:00.000Z", severity: "high", sessionId: "s", harness: "codex" }],
    } };
  });
  await page.goto("/");
  await roboRepoCard(page).getByRole("link", { name: "RoboRepo activity", exact: true }).click();
  await expect(page).toHaveURL(/\/tokens\?repository=[a-z0-9-]+$/);
  await expect(selector(page)).toHaveAccessibleName("Repository: RoboRepo");
});
