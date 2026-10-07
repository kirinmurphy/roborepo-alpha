import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";

const NAV_ORDER = ["Repos", "Agents", "Plans", "Tokens", "Runtime", "Settings"];
const ROUTES = [
  { path: "/", active: "Repos" },
  { path: "/config", active: "Agents" },
  { path: "/plans", active: "Plans" },
  { path: "/tokens", active: "Tokens" },
  { path: "/runtime", active: "Runtime" },
  { path: "/settings", active: "Settings" },
];

test.describe("repository-first portal Home", () => {
  test("Home renders the canonical repository directory", async ({ page }) => {
    const response = await page.goto("/");
    expect(response.status()).toBe(200);
    await expect(page.getByRole("heading", { level: 1, name: "Active Repos" })).toBeVisible();
    const card = roboRepoCard(page);
    await expect(card).toHaveCount(1);
    await expect(card).toContainText("RoboRepo");
    await expect(card).not.toContainText("Coverage unavailable");
    await expect(card.locator(".repository-state-badge")).toHaveText("idle");
    await expect(page.locator("body")).not.toContainText("/private/");
  });

  test("plans lead the card below main; a matched plan is its worktree's row and unclaimed worktrees follow", async ({ page }) => {
    await planFixture(page);
    await page.goto("/");
    const card = roboRepoCard(page);
    await expect(cardRows(card)).toHaveText([
      /main branch/, /Plan A/, /Plan B/, /Plan C/, /Plan D/, /feature\/loose/,
    ], { useInnerText: true });
    await expect(card.getByRole("heading", { name: /Active Plans|Additional Plans/ })).toHaveCount(0);
    for (const title of ["Plan A", "Plan B", "Plan C", "Plan D"]) {
      await expect(card.getByRole("button", { name: title, exact: true })).toHaveCount(1);
    }

    const matched = planRowOf(card, "Plan A");
    await expect(matched.getByRole("progressbar", { name: "Plan A completion" })).toHaveAttribute("aria-valuenow", "50");
    await expect(matched.getByRole("link", { name: ":5173" })).toHaveAttribute("href", "http://127.0.0.1:5173");
    await expect(matched.getByRole("button", { name: "Links" })).toBeVisible();
    await expect(matched.getByRole("button", { name: "Worktree details for Plan A" })).toBeVisible();
    // The matched worktree's branch label and copy control give way to the plan, and the worktree is
    // not listed again below.
    await expect(card.getByText("feature/a", { exact: true })).toHaveCount(0);
    await expect(matched.locator("[data-slot=root-copy] *")).toHaveCount(0);
    // Same checkout, same Git warning: the unclaimed worktree carries identical drift.
    const loose = checkoutRow(card, "feature/loose");
    await expect(matched.locator(".git-drift")).toHaveText("⚠ 3 behind remote");
    await expect(loose.locator(".git-drift")).toHaveText("⚠ 3 behind remote");

    const noApp = planRowOf(card, "Plan B");
    await expect(noApp.locator(".plan-complete-badge")).toHaveText("done");
    await expect(noApp.getByRole("progressbar")).toHaveCount(0);
    await expect(noApp.getByRole("link")).toHaveCount(0);
    await expect(noApp.getByRole("button", { name: "Links" })).toHaveCount(0);

    const notStarted = planRowOf(card, "Plan C");
    await expect(notStarted.locator(".plan-match-badge")).toHaveText("not started");
    await expect(notStarted.locator(".plan-match-badge")).toHaveAttribute("title", "No worktree is associated with this plan");
    const notRunning = planRowOf(card, "Plan D");
    await expect(notRunning.locator(".plan-match-badge")).toHaveText("worktree not running");
    await expect(notRunning.locator(".plan-match-badge")).toHaveAttribute("title", 'Home has no running checkout for worktree "gone"');
    for (const row of [notStarted, notRunning]) {
      await expect(row.getByRole("link")).toHaveCount(0);
      await expect(row.getByRole("button", { name: "Links" })).toHaveCount(0);
    }

    // An unclaimed worktree is the same checkout row as before: branch label with its tooltip, copy
    // control, port, and Links.
    await expect(loose.locator("[data-slot=root-info]")).toBeVisible();
    await expect(loose.locator("[data-slot=root-copy] portal-copy-menu")).toHaveCount(1);
    await expect(loose.getByRole("link", { name: ":5174" })).toBeVisible();
    await expect(loose.getByRole("button", { name: "Links" })).toBeVisible();

    // No repository-wide plan counts row: backlog counts were noise on Home.
    await expect(card).not.toContainText("backlog");
    await expect(card.getByRole("heading", { name: "Token Warnings" })).toBeVisible();
    await expect(card).toContainText(/8 warnings from \d{2}\/\d{2} to \d{2}\/\d{2}/);
    await expect(card.getByRole("list", { name: "Token warnings" }).getByRole("listitem")).toHaveText([
      "3 token spikes and 2 repeated tool loops in gpt-5-codex",
      "3 repeated tool loops in claude-opus-4-8",
    ]);
    await expect(card.getByRole("link", { name: "all activity", exact: true })).toHaveAttribute("href", "/tokens");
    await expect(card.locator(".home-domain-row.is-warning")).toHaveCount(1);
    await expect(card.locator(".status-dot")).toHaveCount(0);
  });

  test("the worktree details dropdown copies each value in place and lists only non-default facts", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await planFixture(page);
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    const panel = card.locator(".worktree-details");
    // The worktree is identified by its path alone; its name was the path's last segment repeated.
    await expect(panel.locator(".worktree-detail-value")).toHaveText(["feature/a", "/private/wt/feature-a"]);
    await expect(panel.getByRole("list", { name: "Worktree status" }).getByRole("listitem")).toHaveText([
      "dirty", "0 ahead, 3 behind origin/feature/a", "4 commits behind main",
    ]);
    for (const name of ["Copy branch name", "Copy worktree path"]) {
      await expect(panel.getByRole("button", { name })).toHaveCount(1);
    }
    await expect(panel.getByRole("button", { name: "Copy worktree name" })).toHaveCount(0);

    await panel.getByRole("button", { name: "Copy worktree path" }).click();
    const row = panel.locator(".worktree-detail-row").nth(1);
    await expect(panel).toBeVisible();
    await expect(row).toHaveText("Copied", { useInnerText: true });
    await expect(row.getByText("/private/wt/feature-a", { exact: true })).toBeHidden();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/private/wt/feature-a");
    // The shared confirmation interval (5 s), then the value returns.
    await expect(row.getByText("/private/wt/feature-a", { exact: true })).toBeVisible({ timeout: 8_000 });
    await expect(row).not.toContainText("Copied");

    // Closing the panel mid-confirmation resets the button, so reopening shows the value, not a stuck
    // "Copied".
    await panel.getByRole("button", { name: "Copy branch name" }).click();
    await expect(panel.locator(".worktree-detail-row").first()).toHaveText("Copied", { useInnerText: true });
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    await expect(panel.locator(".worktree-detail-row").first()).toHaveText("feature/a", { useInnerText: true });
    await expect(panel.getByRole("button", { name: "Copy branch name" })).toBeEnabled();

    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Worktree details for Plan B" }).click();
    await expect(card.locator(".worktree-details .worktree-detail-value")).toHaveText(["feature/b", "feature-b"]);
    await expect(card.locator(".worktree-details").getByRole("list", { name: "Worktree status" })).toBeHidden();
  });

  test("a long worktree path is middle-truncated to 50 characters, and copies and titles in full", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const longPath = "/Users/someone/.worktrees/roborepo/claude/a-very-long-feature-branch-worktree-name";
    await planFixture(page, (repository) => {
      repository.domains.runtime.data.checkouts.find((checkout) => checkout.rootId === "matched").projectRoot = longPath;
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    const value = card.locator(".worktree-details .worktree-detail-value").nth(1);
    await expect(value).toHaveText("/Users/someone/.worktrees…ure-branch-worktree-name");
    await expect(value).toHaveAttribute("title", longPath);
    await card.getByRole("button", { name: "Copy worktree path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(longPath);
  });

  test("without active plans, or without Plans data, linked worktrees render as before", async ({ page }) => {
    let plansEnvelope;
    await planFixture(page, (repository) => { repository.domains.plans = plansEnvelope; });
    for (const envelope of [
      { status: "unavailable", updatedAt: null, data: null, message: "Plans has not scanned this repository" },
      { status: "available", data: { counts: { active: 0, backlog: 5 }, active: [], recent: [] } },
    ]) {
      plansEnvelope = envelope;
      await page.goto("/");
      const card = roboRepoCard(page);
      await expect(cardRows(card)).toHaveText([/main branch/, /feature\/a/, /feature\/b/, /feature\/loose/], { useInnerText: true });
      await expect(checkoutRow(card, "feature/a").locator("[data-slot=root-copy] portal-copy-menu")).toHaveCount(1);
      await expect(card).not.toContainText("Plans has not scanned this repository");
    }
  });

  test("without Runtime every plan is badged", async ({ page }) => {
    await planFixture(page, (repository) => {
      repository.domains.runtime = { status: "unavailable", updatedAt: null, data: null, message: "Runtime data is unavailable" };
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    await expect(cardRows(card)).toHaveText([/No known checkout/, /Plan A/, /Plan B/, /Plan C/, /Plan D/], { useInnerText: true });
    await expect(card.locator(".plan-match-badge")).toHaveText(["worktree not running", "worktree not running", "not started", "worktree not running"]);
  });

  test("Home Links renders its glyph, discovers routes and closes with Escape", async ({ page }) => {
    await homeFixture(page);
    await page.route("**/api/developer-runtime/metadata?*", (route) => route.fulfill({ json: { suggestions: [
      { kind: "page", source: "sitemap", path: "/docs" },
      { kind: "api", source: "openapi", method: "GET", path: "/api/example" },
    ] } }));
    await page.goto("/");
    const card = roboRepoCard(page);
    const links = card.getByRole("button", { name: "Links", exact: true });
    await expect(links.locator("portal-icon[name=link] svg")).toBeVisible();
    await expect(card.locator(".checkout-control-cell")).toHaveCount(0);
    await links.click();
    await expect(card.getByRole("link", { name: /\/docs/ })).toHaveAttribute("href", "http://127.0.0.1:4317/docs");
    await page.keyboard.press("Escape");
    await expect(links).toHaveAttribute("aria-expanded", "false");
    await links.click();
    await card.getByRole("button", { name: /GET.*api\/example/ }).click();
    await expect(page.getByRole("dialog")).toBeVisible();
    await page.getByRole("button", { name: "Close", exact: true }).click();
    await expect(page.getByRole("dialog")).not.toBeVisible();
  });

  test("Home shows harness setup as an info prompt linking what it unlocks", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: { supported: [{ id: "claude", displayName: "Claude Code" }, { id: "codex", displayName: "Codex" }], detected: [], active: [] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner).toHaveClass(/notice-info/);
    await expect(banner.locator("[data-notice-icon] portal-icon")).toHaveAttribute("name", "info");
    await expect(banner.getByRole("link", { name: "agent tools" })).toHaveAttribute("href", "/config");
    await expect(banner.getByRole("link", { name: "token tracking" })).toHaveAttribute("href", "/tokens");
    await expect(banner.locator(".harness-setup-supported")).toHaveText("Supported Harnesses: Claude Code, Codex");
  });

  test("Settings renders shared setup controls and can check for harness installs", async ({ page }) => {
    await page.route("**/api/repositories/sources", (route) => route.fulfill({ json: {
      revision: 1,
      loadError: null,
      autoDiscovery: { id: "auto-discovery", enabled: false, repositoryCount: 0 },
      repositories: [],
      sources: [],
    } }));
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 0, visibleCount: 0, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: {
        supported: [{ id: "codex", displayName: "Codex" }],
        detected: [{ id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true }],
        active: [{ id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true }],
      },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.goto("/settings");
    await expect(page.locator('nav a[aria-label="Settings"] portal-icon svg')).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Repos" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Agent Harnesses" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Token Activity" })).toBeVisible();
    await expect(page.locator("#repository-sources-inline .sources-repositories")).toBeVisible();
    await expect(page.locator("#repository-sources-inline .sources-repositories h3")).toHaveCount(0);
    await expect(page.locator("#repository-sources-inline").getByRole("button", { name: "Auto-discover active repos" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check for installs" })).toHaveAttribute("data-btn", "text");
    const response = page.waitForResponse((res) => res.url().includes("/api/config/harnesses/refresh") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Check for installs" }).click();
    await response;
    await expect(page.locator("#harness-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable Codex" })).toBeVisible();
    await expect(page.getByText("Enable token telemetry", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable token telemetry" })).toHaveText("Enable");
  });

  test("Settings explains an empty harness catalog and responds to a setup-state error", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 0, visibleCount: 0, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: { supported: [], detected: [], active: [] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.goto("/settings");
    await expect(page.getByRole("status", { name: "No supported harnesses are registered." })).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/settings", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "setup service unavailable" }),
    }));
    await page.reload();
    await expect(page.locator("#settings-error")).toHaveText("setup service unavailable");
    await expect(page.locator("#telemetry-toggle")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Check for installs" })).toBeEnabled();
  });

  test("Settings shows one non-actionable status for an undetected harness", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 0, visibleCount: 0, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: { supported: [{ id: "codex", displayName: "Codex" }], detected: [], active: [] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.goto("/settings");
    const row = page.locator("#harness-list .settings-list-row");
    await expect(row).toContainText("Codex");
    await expect(row.getByRole("status")).toHaveText("Not detected");
    await expect(row.getByRole("button")).toHaveCount(0);
  });

  test("Settings keeps its section actions usable on a narrow viewport", async ({ page }) => {
    await page.setViewportSize({ width: 360, height: 800 });
    await page.goto("/settings");
    await expect(page.locator("main.settings-main")).toBeVisible();
    await expect(page.locator("#repository-sources-inline")).toBeVisible();
    const bounds = await page.locator("main.settings-main").boundingBox();
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(360);
  });

  // The detail page is parked: names are plain text and every /repositories/* URL lands on Home.
  test("repository names do not link out while the detail page is parked", async ({ page }) => {
    await page.goto("/");
    await expect(roboRepoCard(page).getByRole("heading", { name: "RoboRepo", exact: true })).toBeVisible();
    await expect(page.getByRole("link", { name: "RoboRepo", exact: true })).toHaveCount(0);
  });

  test("repository detail URLs redirect Home", async ({ page }) => {
    for (const path of ["/repositories/roborepo", "/repositories/not-a-repository"]) {
      await page.goto(path);
      await expect(page).toHaveURL(/\/$/);
      await expect(page.getByRole("heading", { level: 1, name: "Active Repos" })).toBeVisible();
    }
  });

  test("global navigation remains the static five-item manifest", async ({ page }) => {
    await page.goto("/");
    const labels = await page.locator("#nav a").allTextContents();
    expect(labels.map((label) => label.trim())).toEqual(NAV_ORDER);
    for (const { path, active } of ROUTES) {
      const response = await page.goto(path);
      expect(response.status()).toBe(200);
      await expect(page.locator("#nav a.active")).toHaveText(active);
      await expect(page.locator("#nav a.active")).toHaveCount(1);
    }
  });

  test("the content column stays centered and the card responds at mobile width", async ({ page }) => {
    await page.goto("/");
    const desktop = await page.locator("main.inner").evaluate((element) => {
      const rect = element.getBoundingClientRect();
      return { maxWidth: getComputedStyle(element).maxWidth, left: rect.left, right: innerWidth - rect.right };
    });
    expect(desktop.maxWidth).toBe("1024px");
    expect(Math.abs(desktop.left - desktop.right)).toBeLessThanOrEqual(1);
    await page.setViewportSize({ width: 420, height: 780 });
    const card = await roboRepoCard(page).boundingBox();
    expect(card.x).toBeGreaterThanOrEqual(0);
    expect(card.x + card.width).toBeLessThanOrEqual(420);
  });

  test("theme toggling persists across page navigation", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("html")).toHaveAttribute("data-theme", "dark");
    await page.locator("#theme-toggle").click();
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
    await page.locator("#nav").getByRole("link", { name: "Runtime", exact: true }).click();
    await expect(page).toHaveURL(/\/runtime$/);
    await expect(page.locator("html")).toHaveAttribute("data-theme", "light");
  });

  test("navigation and repository actions have visible keyboard focus", async ({ page, request }) => {
    // An active harness keeps the setup banner (and its links) out of the tab order, so the first
    // stop after the nav is always the repository card — not whichever of the two rendered first.
    const config = await (await request.get("/api/config")).json();
    config.machineHarnesses = [{ id: "claude", enabled: true, confidence: "confirmed" }];
    await page.route("**/api/config", (route) => route.fulfill({ json: config }));
    await page.goto("/");
    await expect(roboRepoCard(page)).toBeVisible();
    await page.keyboard.press("Tab");
    const logo = await focusSummary(page);
    expect(logo.ariaLabel).toBe("roborepo home");
    expect(logo.visible).toBe(true);
    for (const expected of NAV_ORDER) {
      await page.keyboard.press("Tab");
      const focused = await focusSummary(page);
      expect(focused.text).toBe(expected);
      expect(focused.visible).toBe(true);
    }
    // The compact Enable prompt now sits above the Active Repos section, so its action comes before
    // the heading's Manage repositories action and both come before the first card.
    for (const expected of ["Auto-discover active repos", "Manage Repos"]) {
      await page.keyboard.press("Tab");
      const focused = await focusSummary(page);
      expect(focused.text).toBe(expected);
      expect(focused.visible).toBe(true);
    }
    await page.keyboard.press("Tab");
    // Repository names are plain text while the detail page is parked, so the first card control is
    // the provider link (when the repository has one) or the actions menu.
    const firstCardControl = await focusSummary(page);
    expect(["GitHub", "Actions"]).toContain(firstCardControl.ariaLabel);
    expect(firstCardControl.visible).toBe(true);
  });

  test("repository row exposes the configured Home actions", async ({ page }) => {
    await page.goto("/");
    await roboRepoCard(page).getByRole("button", { name: "Actions" }).click();
    const menu = roboRepoCard(page).locator(".menu-panel");
    await expect(menu.locator("> *")).toHaveText(["Forget This Repo", "Pin", "Repo Agent Configcoming soon"]);
    const agents = menu.getByRole("button", { name: /Repo Agent Config/ });
    await expect(agents).toBeDisabled();
    await expect(agents.locator(".menu-item-hint")).toHaveText("coming soon");
    await expect(page.locator("#home-content").getByRole("link", { name: "Agents", exact: true })).toHaveCount(0);
  });
});

function focusSummary(page) {
  return page.evaluate(() => {
    const element = document.activeElement;
    const style = getComputedStyle(element);
    return {
      text: (element.textContent || "").trim(),
      href: element.getAttribute("href"),
      ariaLabel: element.getAttribute("aria-label"),
      visible: element.matches(":focus-visible") && style.outlineStyle !== "none" && Number.parseFloat(style.outlineWidth) > 0,
    };
  });
}

// One real plan through the real plans pipeline: a throwaway repository with a docs/plans file,
// added as a repository source through the same API the Manage repositories dialog uses.
test.describe("shared plan drawer", () => {
  let planRoot;
  test.beforeAll(() => {
    planRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-plans-"));
    fs.mkdirSync(path.join(planRoot, ".git"));
    fs.mkdirSync(path.join(planRoot, "docs", "plans", "active"), { recursive: true });
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "drawer-fixture.md"), [
      "---", "id: drawerfx", "priority: high", "next_action: Check the drawer", "---", "",
      "# Drawer fixture plan", "", "## Summary", "", "Body text for the drawer.", "",
      "## Tasks", "", "- [x] First task", "- [ ] Second task", "",
    ].join("\n"));
  });
  test.afterAll(() => fs.rmSync(planRoot, { recursive: true, force: true }));
  test.beforeEach(async ({ page }) => addRepositorySource(page, planRoot));
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  test("a Plans card opens the plan drawer", async ({ page }) => {
    // The board only shows once plan-write is enabled; the hermetic machine has no packages.
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planWritePackage = { ...data.planWritePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
    await page.goto("/plans");
    await page.getByText("Drawer fixture plan").first().click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("#drawer-title")).toHaveText("Drawer fixture plan");
    await expect(drawer.locator("plan-status option-dropdown").first()).toBeVisible();
  });

  test("a Home plan title opens the same drawer, read-only, without leaving Home", async ({ page }) => {
    const plans = await (await page.request.get("/api/plans")).json();
    const record = plans.plans.find((item) => item.plan.title === "Drawer fixture plan");
    await patchRoboRepo(page, (repository) => {
      repository.domains.plans = { status: "available", data: {
        counts: { active: 1, backlog: 0 },
        active: [{ id: "drawerfx", key: record.key, title: "Drawer fixture plan", worktree: "", taskCounts: { total: 2, complete: 1 } }],
      } };
    });
    await page.goto("/");
    await roboRepoCard(page).getByRole("button", { name: "Drawer fixture plan" }).click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(drawer.locator("#drawer-title")).toHaveText("Drawer fixture plan");
    await expect(drawer.locator("#drawer-tasks li")).toHaveCount(2);
    await expect(drawer.locator("plan-status option-dropdown")).toHaveCount(0);
    await expect(drawer.locator("plan-status .chip").first()).toHaveText("Active");
    await page.keyboard.press("Escape");
    await expect(drawer).not.toBeVisible();
  });

  test("a matched plan row opens the same read-only drawer", async ({ page }) => {
    const plans = await (await page.request.get("/api/plans")).json();
    const record = plans.plans.find((item) => item.plan.title === "Drawer fixture plan");
    await patchRoboRepo(page, (repository) => {
      const plan = { id: "drawerfx", key: record.key, title: "Drawer fixture plan", worktree: "drawer-tree", checkoutRootId: "drawer-tree", taskCounts: { total: 2, complete: 1 } };
      repository.domains.plans = { status: "available", data: { counts: { active: 1, backlog: 0 }, active: [plan] } };
      repository.domains.runtime = { status: "available", data: { checkouts: [
        { rootId: "drawer-tree", name: "feature/drawer", isWorktree: true, worktreeName: "drawer-tree", git: { branch: "feature/drawer", provider: { ok: true } } },
      ] } };
    });
    await page.goto("/");
    await planRowOf(roboRepoCard(page), "Drawer fixture plan").getByRole("button", { name: "Drawer fixture plan", exact: true }).click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer).toBeVisible();
    await expect(page).toHaveURL(/\/$/);
    await expect(drawer.locator("#drawer-title")).toHaveText("Drawer fixture plan");
    await expect(drawer.locator("plan-status option-dropdown")).toHaveCount(0);
  });
});

test.describe("Plans card commands", () => {
  test.use({ permissions: ["clipboard-read", "clipboard-write"] });
  let planRoot;
  const plan = (id, title, tasks) => [
    "---", `id: ${id}`, "priority: high", "next_action: Do the next thing", "---", "",
    `# ${title}`, "", "## Summary", "", "Body.", "", "## Tasks", "", tasks, "",
  ].join("\n");
  test.beforeAll(() => {
    planRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-commands-"));
    fs.mkdirSync(path.join(planRoot, ".git"));
    for (const lifecycle of ["backlog", "active"]) fs.mkdirSync(path.join(planRoot, "docs", "plans", lifecycle), { recursive: true });
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "card-backlog.md"), plan("cardbk01", "Backlog card plan", "- [ ] Todo"));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "card-done.md"), plan("cardac01", "Finished card plan", "- [x] Done"));
  });
  test.afterAll(() => fs.rmSync(planRoot, { recursive: true, force: true }));
  test.beforeEach(async ({ page }) => {
    await addRepositorySource(page, planRoot);
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planWritePackage = { ...data.planWritePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  // The portal copies suite commands; it never moves a plan on their behalf, since /plan-start and
  // /plan-close make and commit those moves themselves.
  for (const [tab, title, label, command, folder] of [
    ["Backlog", "Backlog card plan", "Start", "plan-start", "backlog/card-backlog.md"],
    ["Active", "Finished card plan", "Close", "plan-close", "active/card-done.md"],
  ]) {
    test(`a ${tab.toLowerCase()} card's ${label} copies the /${command} prompt and moves nothing`, async ({ page }) => {
      await page.goto("/plans");
      await page.getByText(new RegExp(`^${tab} \\(`)).first().click();
      const card = page.locator("plan-card", { hasText: title });
      const prompt = page.waitForRequest((request) => request.url().endsWith("/api/plans/prompt"));
      await card.getByRole("button", { name: label, exact: true }).click();
      expect((await prompt).postDataJSON().action).toBe(command);
      await expect(page.locator("#toast")).toContainText(`Copied the /${command} prompt`);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^/${command}\\n`));
      await expect(card.getByRole("button", { name: "Archive" })).toHaveCount(0);
      expect(fs.existsSync(path.join(planRoot, "docs", "plans", folder)), `${folder} stays where it was`).toBe(true);
    });
  }
});

test.describe("Plans onboarding", () => {
  const SUITE = ["plan-write", "plan-promote", "plan-start", "plan-close", "session-close"];

  test("each suite command's details button opens that command's skill", async ({ page }) => {
    await page.goto("/plans");
    const banner = page.locator(".package-onboarding");
    await expect(banner.getByRole("heading", { name: /plan suite/ })).toBeVisible();
    const modal = page.locator("dialog#skill-modal");
    for (const skill of SUITE) {
      await expect(banner.locator("code", { hasText: `/${skill}` })).toBeVisible();
      await banner.getByRole("button", { name: `View /${skill} details` }).click();
      await expect(modal).toBeVisible();
      await expect(modal.locator("[data-slot=path]")).toContainText(`${skill}/SKILL.md`);
      await modal.locator("[data-slot=close]").click();
      await expect(modal).not.toBeVisible();
    }
  });

  test("the enable button turns on all five suite packages in one request", async ({ page }) => {
    await page.goto("/plans");
    const token = await page.locator("meta[name=cli-portal-token]").getAttribute("content");
    const bulk = page.waitForRequest((request) => request.url().endsWith("/api/config/packages/bulk") && request.method() === "POST");
    await page.locator(".package-onboarding").getByRole("button", { name: "Enable the Plan Suite" }).click();
    expect((await bulk).postDataJSON()).toEqual({ ids: SUITE, enabled: true });
    await expect(page.locator(".package-onboarding")).toBeHidden();
    const config = await (await page.request.get("/api/config")).json();
    const section = config.behaviorView.find((item) => item.categoryId === "skills-dev-lifecycle");
    for (const skill of SUITE) {
      expect(section.items.find((item) => item.id === skill)?.active, `${skill} enabled`).toBe(true);
    }
    // Leave the hermetic machine as the other specs expect it: no suite packages enabled.
    const reset = await page.request.post("/api/config/packages/bulk", {
      headers: { "X-Cli-Portal-Token": token },
      data: { ids: SUITE, enabled: false },
    });
    expect(reset.ok()).toBe(true);
  });
});

async function portalToken(page) {
  await page.goto("/plans");
  return page.locator("meta[name=cli-portal-token]").getAttribute("content");
}

async function addRepositorySource(page, sourcePath) {
  const response = await page.request.post("/api/repositories/sources", {
    headers: { "X-Cli-Portal-Token": await portalToken(page) },
    data: { path: sourcePath },
  });
  expect(response.ok()).toBe(true);
}

// The repositories a removed source found stay registered (removal never deletes a repository),
// which is harmless here: each fixture is its own repository and its folder outlives the describe.
async function removeRepositorySources(page) {
  const token = await portalToken(page);
  const { sources } = await (await page.request.get("/api/repositories/sources")).json();
  for (const source of sources) {
    const response = await page.request.post(`/api/repositories/sources/${source.id}/remove`, { headers: { "X-Cli-Portal-Token": token } });
    expect(response.ok()).toBe(true);
  }
}

// Every row below the repository row, in order: checkouts, plan rows, and the plan summary line.
function cardRows(card) {
  return card.locator("[data-slot=checkouts] > *");
}

function planRowOf(card, title) {
  return card.locator(".repository-root").filter({ has: card.page().getByRole("button", { name: title, exact: true }) });
}

function checkoutRow(card, branch) {
  return card.locator(".repository-root").filter({ has: card.page().getByText(branch, { exact: true }) });
}

function roboRepoCard(page) {
  return page.locator(".repository-card").filter({ has: page.getByRole("heading", { name: "RoboRepo", exact: true }) }).first();
}

// Serves the real /api/home response with the RoboRepo repository adjusted by `mutate`, so each test
// states only the domain data it depends on.
async function patchRoboRepo(page, mutate) {
  await page.route("**/api/home", async (route) => {
    const data = await (await route.fetch()).json();
    mutate(data.repositories.find((item) => item.displayName === "RoboRepo"));
    await route.fulfill({ json: data });
  });
}

async function homeFixture(page) {
  await patchRoboRepo(page, (repository) => {
    repository.domains.plans = { status: "available", data: { counts: { active: 0, backlog: 0 }, active: [], recent: [] } };
    repository.domains.tokens = { status: "available", data: {
      warningCount: 8,
      warnings: [
        ...Array.from({ length: 3 }, () => ({ kind: "spike", model: "gpt-5-codex", at: "2026-09-24T12:00:00.000Z" })),
        ...Array.from({ length: 2 }, () => ({ kind: "loop", model: "gpt-5-codex", at: "2026-09-28T12:00:00.000Z" })),
        ...Array.from({ length: 3 }, () => ({ kind: "loop", model: "claude-opus-4-8", at: "2026-09-30T12:00:00.000Z" })),
      ].map((warning, index) => ({ ...warning, severity: "high", sessionId: `session-${index}`, harness: "codex" })),
    } };
    repository.domains.runtime = { status: "available", data: { checkouts: [{
      rootId: "main", name: "main", git: { branch: "main", provider: { ok: true } },
      primaryEntrypoint: { kind: "listener", opaqueKey: "fixture", origin: "http://127.0.0.1:4317", port: 4317, links: [] },
    }] } };
  });
}

// A repository with main, two plan-matched worktrees (one with an app, one without), an unclaimed
// worktree, two unmatched plans, and token warnings. `adjust` edits the repository after the fixture.
async function planFixture(page, adjust) {
  await patchRoboRepo(page, (repository) => {
    const drift = { behind: 3, ahead: 0 };
    const app = (port, key) => ({ kind: "listener", opaqueKey: key, origin: `http://127.0.0.1:${port}`, port, links: [] });
    const worktree = (rootId, name, branch, { git = {}, entrypoint = null } = {}) => ({
      rootId, name: branch, isWorktree: true, worktreeName: name, projectRoot: `/private/wt/${name}`, checkoutState: "present",
      git: { branch, provider: { ok: true }, ...git }, primaryEntrypoint: entrypoint,
    });
    repository.domains.runtime = { status: "available", data: { checkouts: [
      { rootId: "main", name: "main", isWorktree: false, worktreeName: null, git: { branch: "main", provider: { ok: true } }, primaryEntrypoint: app(4317, "fixture") },
      worktree("matched", "feature-a", "feature/a", {
        git: { ...drift, upstream: "origin/feature/a", dirty: true, baseBehind: 4, baseBranch: "origin/main" },
        entrypoint: app(5173, "matched-key"),
      }),
      { ...worktree("no-app", "feature-b", "feature/b"), projectRoot: null },
      worktree("loose", "loose", "feature/loose", { git: { ...drift, upstream: "origin/feature/loose" }, entrypoint: app(5174, "loose-key") }),
    ] } };
    repository.domains.plans = { status: "available", data: {
      counts: { active: 4, backlog: 5 },
      active: [
        { id: "a", key: "a", title: "Plan A", worktree: "feature-a", checkoutRootId: "matched", taskCounts: { total: 4, complete: 2 } },
        { id: "b", key: "b", title: "Plan B", worktree: "feature-b", checkoutRootId: "no-app", taskCounts: { total: 3, complete: 3 } },
        { id: "c", key: "c", title: "Plan C", worktree: "", taskCounts: { total: 0, complete: 0 } },
        { id: "d", key: "d", title: "Plan D", worktree: "gone", taskCounts: { total: 2, complete: 0 } },
      ],
      recent: [],
    } };
    repository.domains.tokens = { status: "available", data: {
      warningCount: 8,
      warnings: [
        ...Array.from({ length: 3 }, () => ({ kind: "spike", model: "gpt-5-codex", at: "2026-09-24T12:00:00.000Z" })),
        ...Array.from({ length: 2 }, () => ({ kind: "loop", model: "gpt-5-codex", at: "2026-09-28T12:00:00.000Z" })),
        ...Array.from({ length: 3 }, () => ({ kind: "loop", model: "claude-opus-4-8", at: "2026-09-30T12:00:00.000Z" })),
      ].map((warning, index) => ({ ...warning, severity: "high", sessionId: `session-${index}`, harness: "codex" })),
    } };
    adjust?.(repository);
  });
}
