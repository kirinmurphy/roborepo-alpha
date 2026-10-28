// The shared repository scope in the browser: the selector's sub-header row, `?repo=` surviving
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
  // The board only shows once plan-suite is enabled; the hermetic machine has no packages. Matched
  // by path so scoped requests (?repo=) are patched too.
  await page.route((url) => url.pathname === "/api/plans", async (route) => {
    // An unavailable scope's 404 passes through with its status.
    const response = await route.fetch();
    const data = await response.json();
    if (data.planSuitePackage) data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
    await route.fulfill({ response, json: data });
  });
});
test.afterEach(async ({ page }) => removeRepositorySources(page));

const selector = (page) => page.getByRole("button", { name: /^Repo: / });
const scopeParam = (page) => new URL(page.url()).searchParams.get("repo");

async function chooseScope(page, label) {
  await selector(page).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

test("the selector is a full-width row inside the sticky site header, right-aligned in the page column", async ({ page }) => {
  await page.setViewportSize({ width: 1600, height: 900 });
  await page.goto("/plans");
  await expect(selector(page)).toBeVisible();
  const bar = page.locator(".portal-header > .repository-scope-bar");
  await expect(bar).toHaveCount(1);
  await expect(bar.getByText("Viewing", { exact: true })).toBeVisible();
  const layout = await bar.evaluate((node) => {
    const header = document.querySelector(".portal-header");
    const row = node.getBoundingClientRect();
    const column = node.querySelector(".inner").getBoundingClientRect();
    const trigger = node.querySelector(".dropdown-trigger").getBoundingClientRect();
    const pageColumn = document.querySelector("main.inner, #main, main")?.getBoundingClientRect();
    return {
      stickyHeader: getComputedStyle(header).position,
      belowLogoRow: row.top >= header.querySelector(":scope > .inner").getBoundingClientRect().bottom - 1,
      fullWidth: Math.round(row.width) === document.documentElement.clientWidth,
      columnWidth: Math.round(column.width),
      ownBackground: getComputedStyle(node).backgroundColor !== getComputedStyle(document.body).backgroundColor,
      alignedWithPage: pageColumn ? Math.abs(column.left - pageColumn.left) < 1 : true,
      rightAligned: Math.abs(trigger.right - (column.right - 20)) < 1,
    };
  });
  expect(layout).toEqual({ stickyHeader: "sticky", belowLogoRow: true, fullWidth: true, columnWidth: 1024, ownBackground: true, alignedWithPage: true, rightAligned: true });
});

test("the header, its repo row, and Plans' lifecycle row stay pinned together while the page scrolls", async ({ page }) => {
  await page.setViewportSize({ width: 1200, height: 500 });
  await page.goto("/plans");
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  const pinned = await page.evaluate(() => ({
    header: document.querySelector(".portal-header").getBoundingClientRect(),
    bar: document.querySelector(".repository-scope-bar").getBoundingClientRect(),
    lifecycle: document.querySelector("#plans-header").getBoundingClientRect(),
  }));
  expect(pinned.header.top).toBe(0);
  expect(pinned.bar.top).toBeGreaterThan(0);
  // The lifecycle row sits directly under the repo row, where it was before scrolling.
  expect(Math.abs(pinned.lifecycle.top - pinned.header.bottom)).toBeLessThanOrEqual(1);
});

test("the scope travels between Plans, Tokens, and Agents and drops for Runtime, Settings, and Home", async ({ page }) => {
  await page.goto(`/plans?repo=${ALPHA}`);
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
  const nav = page.locator("#nav");
  await expect(nav.locator("> a", { hasText: "Agents" })).toHaveAttribute("href", `/agents?repo=${ALPHA}`);
  await expect(nav.locator("> a", { hasText: "Tokens" })).toHaveAttribute("href", `/tokens?repo=${ALPHA}`);
  await expect(nav.locator("> a", { hasText: "Repos" })).toHaveAttribute("href", "/");
  await expect(page.locator(".portal-logo a")).toHaveAttribute("href", "/");
  await page.getByRole("button", { name: "More pages" }).click();
  const menu = page.locator("#nav-more-panel");
  await expect(menu.getByRole("link", { name: "Runtime" })).toHaveAttribute("href", "/runtime");
  await expect(menu.getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
  await page.keyboard.press("Escape");

  await nav.locator("> a", { hasText: "Tokens" }).click();
  await expect(page).toHaveURL(new RegExp(`/tokens\\?repo=${ALPHA}$`));
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
  await page.locator("#nav > a", { hasText: "Agents" }).click();
  await expect(page).toHaveURL(new RegExp(`/agents\\?repo=${ALPHA}$`));
  await page.getByRole("button", { name: "More pages" }).click();
  await page.locator("#nav-more-panel").getByRole("link", { name: "Runtime" }).click();
  await expect(page).toHaveURL(/\/runtime$/);
  await expect(selector(page)).toHaveCount(0);
});

test("changing the scope keeps Plans filters, and back, forward, and deep links restore it", async ({ page }) => {
  await page.goto(`/plans?repo=${ALPHA}`);
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Search", { exact: true }).fill("high");
  await page.locator("#filters-update").click();
  await expect(page.getByText("Alpha low plan")).toHaveCount(0);

  await chooseScope(page, BETA);
  await expect(page).toHaveURL(new RegExp(`/plans\\?repo=${BETA}$`));
  await expect(page.getByText("Beta high plan")).toBeVisible();
  await expect(page.getByText("Beta low plan")).toHaveCount(0);
  await expect(page.getByText("Alpha high plan")).toHaveCount(0);
  await expect(page.getByLabel("Search", { exact: true })).toHaveValue("high");

  await page.goBack();
  expect(scopeParam(page)).toBe(ALPHA);
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toHaveCount(0);
  await page.goForward();
  expect(scopeParam(page)).toBe(BETA);
  await expect(page.getByText("Beta high plan")).toBeVisible();

  await chooseScope(page, "All repos");
  expect(scopeParam(page)).toBeNull();
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toBeVisible();
});

test("an unavailable scope never shows all repositories and clears to All with page state kept", async ({ page }) => {
  await page.goto("/plans?repo=no-such-repo&lifecycle=active");
  await expect(page.getByRole("heading", { name: "Repo unavailable" })).toBeVisible();
  await expect(selector(page)).toHaveAccessibleName("Repo: Unavailable repo");
  await expect(page.getByText("Alpha high plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Show all repos" }).click();
  await expect(page).toHaveURL(/\/plans\?lifecycle=active$/);
  await expect(page.getByText("Alpha high plan")).toBeVisible();

  await page.goto("/agents?repo=no-such-repo");
  await expect(page.getByRole("heading", { name: "Repo unavailable" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toHaveCount(0);

  // The hermetic machine shows Tokens' demo report, which no route resolves; the selector decides.
  await page.goto("/tokens?repo=no-such-repo");
  await expect(page.getByRole("heading", { name: "Repo unavailable" })).toBeVisible();
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
  await expect(page.getByText("It is not filtered by the selected repo.")).toBeVisible();
  await expect(page.locator("#nav > a", { hasText: "Plans" })).toHaveAttribute("href", "/plans");
  await page.locator("#nav > a", { hasText: "Plans" }).click();
  await expect(page).toHaveURL(/\/plans$/);
  await expect(selector(page)).toHaveAccessibleName("Repo: All repos");
});

test("scoped Agents is a coming-soon splash, and View Global Config returns to global Agents", async ({ page }) => {
  await page.goto(`/agents?repo=${ALPHA}`);
  const splash = page.locator(".page-splash");
  await expect(splash.getByRole("heading", { name: "Repo-level agent config coming soon" })).toBeVisible();
  await expect(splash).toContainText("View per repo agent configurations for rules, skills, hooks, etc.");
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toHaveCount(0);

  await splash.getByRole("button", { name: "View Global Config" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
  await expect(selector(page)).toHaveAccessibleName("Repo: All repos");
});

test("a repository with no plans shows plain copy and View All Repos, not a panel", async ({ page }) => {
  await page.route((url) => url.pathname === "/api/plans", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    await route.fulfill({ response, json: { ...data, plans: [], repositories: [], repositoryScans: [{ repositoryId: "local:aaaaaaaaaaaaaaaa", state: "scanned", planCount: 0, checkoutCount: 1 }], planSuitePackage: { ...data.planSuitePackage, available: true, enabled: true } } });
  });
  await page.goto(`/plans?repo=${ALPHA}`);
  const empty = page.locator("#plans-onboarding .empty-state");
  await expect(empty.getByRole("heading", { name: `No plans yet found in ${ALPHA}` })).toBeVisible();
  expect(await empty.evaluate((node) => getComputedStyle(node).borderTopWidth)).toBe("0px");
  await expect(empty.getByRole("link", { name: "Manage Repos" })).toHaveCount(0);
  await empty.getByRole("link", { name: "View All Repos" }).click();
  expect(scopeParam(page)).toBeNull();
});

test("Tokens shows the empty splash for a repository with no captures, not an empty report", async ({ page }) => {
  const demo = await (await page.request.get("/api/tokens/mock")).json();
  const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed" };
  await page.route("**/api/settings", (route) => route.fulfill({ json: {
    telemetry: { enabled: true, captureAvailable: true },
    harnesses: { supported: [claude], detected: [claude], active: [claude] },
  } }));
  await page.route((url) => url.pathname === "/api/data", (route) => route.fulfill({
    json: { ...demo, capture_count: new URL(route.request().url()).searchParams.has("repo") ? 0 : 1 },
  }));
  await page.goto("/tokens");
  await expect(page.locator("#tokenscontent")).toBeVisible();
  await chooseScope(page, ALPHA);
  await expect(page.getByRole("heading", { name: `No token data yet for ${ALPHA}` })).toBeVisible();
  await expect(page.locator("#tokenscontent")).toBeHidden();
  await chooseScope(page, "All repos");
  await expect(page.locator("#tokens-no-data")).toBeHidden();
  await expect(page.locator("#tokenscontent")).toBeVisible();
});

test("Manage Repos opens the dialog without changing the selected repository", async ({ page }) => {
  await page.goto(`/agents?repo=${ALPHA}`);
  await selector(page).click();
  await expect(page.getByRole("option", { name: "Manage Repos" })).toHaveCount(0);
  await page.getByRole("button", { name: "Manage Repos" }).click();
  await expect(page.locator("dialog#repository-sources-dialog")).toBeVisible();
  expect(scopeParam(page)).toBe(ALPHA);
  await page.keyboard.press("Escape");
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
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
  await roboRepoCard(page).getByRole("link", { name: "all activity", exact: true }).click();
  await expect(page).toHaveURL(/\/tokens\?repo=[a-z0-9-]+$/);
  await expect(selector(page)).toHaveAccessibleName("Repo: RoboRepo");
});

test("Plans filters draft in a popup: Update stays disabled until something changes, Cancel discards", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Monitoring")).toHaveCount(0);
  // Filters is the right-most element of the lifecycle row, with Refresh beside the title; no row of
  // their own above it.
  const bar = await page.locator("#lifecycle-bar").boundingBox();
  const toggle = await page.locator("#filters-toggle").boundingBox();
  expect(Math.abs(toggle.x + toggle.width - bar.x - bar.width)).toBeLessThanOrEqual(1);
  await expect(page.locator("#control-bar")).toHaveCount(0);

  const dialog = page.locator("#filters-dialog");
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(dialog).toBeVisible();
  const update = dialog.getByRole("button", { name: "Update" });
  await expect(update).toBeDisabled();

  // A draft does not filter, and putting it back disables Update again.
  await dialog.getByLabel("Search", { exact: true }).fill("high");
  await expect(update).toBeEnabled();
  await expect(page.getByText("Alpha low plan")).toBeVisible();
  await dialog.getByLabel("Search", { exact: true }).fill("");
  await expect(update).toBeDisabled();

  // Cancel throws the draft away.
  await dialog.getByLabel("Search", { exact: true }).fill("high");
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Alpha low plan")).toBeVisible();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(dialog.getByLabel("Search", { exact: true })).toHaveValue("");

  // Update applies it, and the next open starts clean (disabled) from the applied state.
  await dialog.getByLabel("Search", { exact: true }).fill("high");
  await update.click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText("Alpha low plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(dialog.getByLabel("Search", { exact: true })).toHaveValue("high");
  await expect(update).toBeDisabled();
});

test("moving between scoped pages never flashes an unavailable repo in the selector", async ({ page }) => {
  await page.goto(`/plans?repo=${ALPHA}`);
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
  // Watch every label the selector ever shows on the next page, from the first mutation on.
  await page.addInitScript(() => {
    window.__selectorLabels = [];
    new MutationObserver(() => {
      const trigger = document.querySelector(".repository-scope .dropdown-trigger");
      if (trigger) window.__selectorLabels.push(trigger.textContent.trim());
    }).observe(document, { childList: true, subtree: true, characterData: true });
  });
  await page.locator("#nav > a", { hasText: "Tokens" }).click();
  await expect(page).toHaveURL(new RegExp(`/tokens\\?repo=${ALPHA}$`));
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${ALPHA}`);
  const labels = await page.evaluate(() => window.__selectorLabels);
  expect(labels.length).toBeGreaterThan(0);
  expect(labels.filter((label) => /unavailable/i.test(label))).toEqual([]);
});

test("Plans filter option counts follow the unapplied draft while the board waits for Update", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  const dialog = page.locator("#filters-dialog");
  await page.getByRole("button", { name: "Filters" }).click();
  const allBlockers = dialog.locator("#blocked option[value=all]");
  await expect(allBlockers).toHaveText("all blockers (4)");
  // Searching narrows the other filters' counts at once; the board itself is untouched.
  await dialog.locator("#search").fill("Alpha");
  await expect(allBlockers).toHaveText("all blockers (2)");
  await expect(page.getByText("Beta high plan")).toBeVisible();
  // Cancel returns the counts to the applied filters.
  await dialog.getByRole("button", { name: "Cancel" }).click();
  await page.getByRole("button", { name: "Filters" }).click();
  await expect(allBlockers).toHaveText("all blockers (4)");
});

test("Plans filter options that match nothing are disabled, except the current choice", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await page.getByRole("button", { name: "Filters" }).click();
  const options = await page.locator("#blocked option").evaluateAll((nodes) =>
    nodes.map((node) => ({ text: node.textContent, disabled: node.disabled, selected: node.selected })));
  const empty = options.filter((option) => /\(0\)$/.test(option.text));
  expect(empty.length, "the fixture has blocker states no plan uses").toBeGreaterThan(0);
  for (const option of empty) expect(option.disabled, option.text).toBe(true);
  for (const option of options.filter((candidate) => !/\(0\)$/.test(candidate.text))) expect(option.disabled, option.text).toBe(false);
});
