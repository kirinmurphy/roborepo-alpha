import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";

const NAV_ORDER = ["Repos", "Agents", "Plans", "Tokens", "Runtime"];
const ROUTES = [
  { path: "/", active: "Repos" },
  { path: "/config", active: "Agents" },
  { path: "/plans", active: "Plans" },
  { path: "/tokens", active: "Tokens" },
  { path: "/runtime", active: "Runtime" },
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

  test("Additional Plans stays visible with no rows while empty Tokens stays hidden", async ({ page }) => {
    await patchRoboRepo(page, (repository) => {
      repository.domains.plans = { status: "available", data: { counts: { active: 1, backlog: 3 }, additionalActive: [], recent: [{ id: "done", title: "Recently completed plan", lifecycle: "completed" }] } };
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    const plans = additionalPlans(card);
    await expect(plans.getByRole("heading", { name: "Additional Plans", exact: true })).toBeVisible();
    await expect(plans).toContainText("1 Active · 3 Backlog");
    await expect(plans.getByRole("link", { name: "all plans", exact: true })).toHaveAttribute("href", "/plans");
    await expect(plans.locator(".plan-item")).toHaveCount(0);
    await expect(card).not.toContainText("No active plans");
    await expect(card).not.toContainText("Recently completed plan");
    await expect(card).not.toContainText("Token Warnings");
  });

  test("Additional Plans states partial coverage and is omitted without active plans", async ({ page }) => {
    let plansEnvelope;
    await patchRoboRepo(page, (repository) => { repository.domains.plans = plansEnvelope; });
    plansEnvelope = { status: "partial", message: "Plans coverage is incomplete", data: {
      counts: { active: 1, backlog: 2 },
      additionalActive: [{ id: "partial", title: "Partially scanned plan", taskCounts: { total: 2, complete: 1 } }],
    } };
    await page.goto("/");
    let plans = additionalPlans(roboRepoCard(page));
    await expect(plans).toContainText("1 Active · 2 Backlog");
    await expect(plans).toContainText("Plans coverage is incomplete");
    await expect(plans.getByRole("button", { name: "Partially scanned plan", exact: true })).toBeVisible();

    for (const envelope of [
      { status: "unavailable", updatedAt: null, data: null, message: "Plans has not scanned this repository" },
      { status: "available", data: { counts: { active: 0, backlog: 0 }, additionalActive: [] } },
      { status: "available", data: { counts: { active: 0, backlog: 5 }, additionalActive: [] } },
    ]) {
      plansEnvelope = envelope;
      await page.reload();
      const card = roboRepoCard(page);
      await expect(card.locator(".repository-root").first()).toBeVisible();
      await expect(additionalPlans(card)).toHaveCount(0);
      await expect(card).not.toContainText("Plans has not scanned this repository");
    }
  });

  test("an associated plan renders beneath its worktree and nowhere else", async ({ page }) => {
    await patchRoboRepo(page, (repository) => {
      const associated = { id: "assoc", key: "assoc-key", title: "Worktree plan", worktree: "home-association", taskCounts: { total: 4, complete: 2 } };
      const contested = [
        { id: "contested-a", title: "Contested plan A", worktree: "contested", taskCounts: { total: 0, complete: 0 } },
        { id: "contested-b", title: "Contested plan B", worktree: "contested", taskCounts: { total: 0, complete: 0 } },
      ];
      const unassociated = { id: "loose", title: "Unassociated plan", worktree: "", taskCounts: { total: 1, complete: 0 } };
      repository.domains.plans = { status: "available", data: {
        counts: { active: 4, backlog: 0 },
        additionalActive: [...contested, unassociated],
      } };
      repository.domains.runtime = { status: "available", data: { checkouts: [
        { rootId: "main", name: "main", isWorktree: false, worktreeName: null, git: { branch: "main", provider: { ok: true } } },
        { rootId: "assoc", name: "feature/home-association", isWorktree: true, worktreeName: "home-association", git: { branch: "feature/home-association", provider: { ok: true } }, plan: associated },
        { rootId: "contested", name: "feature/contested", isWorktree: true, worktreeName: "contested", git: { branch: "feature/contested", provider: { ok: true } } },
      ] } };
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    const worktree = checkoutRow(card, "feature/home-association");
    const attached = worktree.getByRole("group", { name: "Plan in this worktree" });
    await expect(attached.getByRole("button", { name: "Worktree plan", exact: true })).toBeVisible();
    await expect(attached.getByRole("progressbar", { name: "Worktree plan completion" })).toHaveAttribute("aria-valuenow", "50");
    await expect(card.getByRole("button", { name: "Worktree plan", exact: true })).toHaveCount(1);
    await expect(checkoutRow(card, "main").getByRole("group", { name: "Plan in this worktree" })).toHaveCount(0);
    await expect(checkoutRow(card, "feature/contested").getByRole("group", { name: "Plan in this worktree" })).toHaveCount(0);

    const plans = additionalPlans(card);
    await expect(plans).toContainText("4 Active · 0 Backlog");
    await expect(plans.locator(".plan-item")).toHaveCount(3);
    for (const title of ["Contested plan A", "Contested plan B", "Unassociated plan"]) {
      await expect(plans.getByRole("button", { name: title, exact: true })).toBeVisible();
    }
    await expect(plans.getByRole("button", { name: "Worktree plan", exact: true })).toHaveCount(0);
  });

  test("Home shows inline plan counts, progress and token warnings rolled up by model", async ({ page }) => {
    await homeFixture(page);
    await page.goto("/");
    const card = roboRepoCard(page);
    await expect(card.getByRole("heading", { name: "Additional Plans", exact: true })).toBeVisible();
    await expect(card).toContainText("2 Active · 22 Backlog");
    await expect(card.getByRole("link", { name: "all plans", exact: true })).toHaveAttribute("href", "/plans");
    await expect(card.getByRole("progressbar", { name: "First plan completion" })).toHaveAttribute("aria-valuenow", "25");
    await expect(planRow(card, "First plan")).toContainText("25%");
    await expect(planRow(card, "Untracked plan")).toContainText("—");
    const finished = planRow(card, "Finished plan");
    await expect(finished.locator(".plan-complete-badge")).toHaveText("done");
    await expect(finished.getByRole("progressbar")).toHaveCount(0);
    await expect(card.locator(".home-domain-row .domain-glyph")).toHaveCount(2);
    await expect(card.getByRole("heading", { name: "Token Warnings" })).toBeVisible();
    await expect(card).toContainText(/8 warnings from \d{2}\/\d{2} to \d{2}\/\d{2}/);
    const warnings = card.getByRole("list", { name: "Token warnings" }).getByRole("listitem");
    await expect(warnings).toHaveText([
      "3 token spikes and 2 repeated tool loops in gpt-5-codex",
      "3 repeated tool loops in claude-opus-4-8",
    ]);
    await expect(card.getByRole("link", { name: "all activity", exact: true })).toHaveAttribute("href", "/tokens");
    await expect(card.locator(".home-domain-row.is-warning")).toHaveCount(1);
    await expect(card.locator(".status-dot")).toHaveCount(0);
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
    await page.route("**/api/config", (route) => route.fulfill({ json: { harnesses: [{ id: "claude", displayName: "Claude Code" }, { id: "codex", displayName: "Codex" }], machineHarnesses: [], packages: [] } }));
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner).toHaveClass(/notice-info/);
    await expect(banner.locator("[data-notice-icon] portal-icon")).toHaveAttribute("name", "info");
    await expect(banner.getByRole("link", { name: "agent tools" })).toHaveAttribute("href", "/config");
    await expect(banner.getByRole("link", { name: "token tracking" })).toHaveAttribute("href", "/tokens");
    await expect(banner.locator(".harness-setup-supported")).toHaveText("Supported Harnesses: Claude Code, Codex");
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
// registered as a discovery root through the same settings API the Plans page uses.
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
  test.beforeEach(async ({ page }) => setPlanRoots(page, [planRoot]));
  test.afterEach(async ({ page }) => setPlanRoots(page, []));

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
        additionalActive: [{ id: "drawerfx", key: record.key, title: "Drawer fixture plan", taskCounts: { total: 2, complete: 1 } }],
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

  test("a plan beneath its worktree opens the same read-only drawer", async ({ page }) => {
    const plans = await (await page.request.get("/api/plans")).json();
    const record = plans.plans.find((item) => item.plan.title === "Drawer fixture plan");
    await patchRoboRepo(page, (repository) => {
      const plan = { id: "drawerfx", key: record.key, title: "Drawer fixture plan", worktree: "drawer-tree", taskCounts: { total: 2, complete: 1 } };
      repository.domains.plans = { status: "available", data: { counts: { active: 1, backlog: 0 }, additionalActive: [] } };
      repository.domains.runtime = { status: "available", data: { checkouts: [
        { rootId: "drawer-tree", name: "feature/drawer", isWorktree: true, worktreeName: "drawer-tree", git: { branch: "feature/drawer", provider: { ok: true } }, plan },
      ] } };
    });
    await page.goto("/");
    await checkoutRow(roboRepoCard(page), "feature/drawer").getByRole("button", { name: "Drawer fixture plan" }).click();
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
    await setPlanRoots(page, [planRoot]);
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planWritePackage = { ...data.planWritePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
  });
  test.afterEach(async ({ page }) => setPlanRoots(page, []));

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

async function setPlanRoots(page, discoveryRoots) {
  await page.goto("/plans");
  const token = await page.locator("meta[name=cli-portal-token]").getAttribute("content");
  const response = await page.request.post("/api/plans/settings", {
    headers: { "X-Cli-Portal-Token": token },
    data: { discoveryRoots },
  });
  expect(response.ok()).toBe(true);
}

function planRow(card, title) {
  return card.locator(".plan-item").filter({ has: card.page().getByRole("button", { name: title, exact: true }) });
}

function additionalPlans(card) {
  return card.locator(".home-domain-row").filter({ has: card.page().getByRole("heading", { name: "Additional Plans", exact: true }) });
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
    const additionalActive = [
      { id: "first", title: "First plan", taskCounts: { total: 4, complete: 1 } },
      { id: "untracked", title: "Untracked plan", taskCounts: { total: 0, complete: 0 } },
      { id: "finished", title: "Finished plan", taskCounts: { total: 3, complete: 3 } },
    ];
    repository.domains.plans = { status: "available", data: { counts: { active: 2, backlog: 22 }, additionalActive } };
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
