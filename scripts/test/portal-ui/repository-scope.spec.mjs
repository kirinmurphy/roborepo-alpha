// The shared repository scope in the browser: the selector's sub-header row, `?repo=` surviving
// navigation between Plans, Tokens, and Agents (and dropping for the rest), browser history, the
// unavailable state, Tokens' Activity outside listed repos, the scoped Agents repo inspector, the Manage
// repositories action row, and Home's scoped Token Warnings link. Two throwaway repositories with
// real plan files run through the real hermetic server.
import crypto from "node:crypto";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createPlanFixture } from "../lib/plan-git-fixture.mjs";
import { removeFixtureContents, addRepositorySource, patchHomeOverview, removeRepositorySources, roboRepoCard } from "./helpers.mjs";

// Unique per worker: a retried worker registers fresh folders, and removing a source never forgets
// the repositories it found, so fixed names would collide with the previous worker's records.
// Lowercase hex keeps each folder name equal to its urlKey.
let ALPHA;
let BETA;
let fx;
test.beforeAll(() => {
  const suffix = crypto.randomBytes(3).toString("hex");
  ALPHA = `alpha-${suffix}`;
  BETA = `beta-${suffix}`;
  fx = createPlanFixture("portal-ui-scope-");
  // Each repo carries its own agent files, so the Agents inspector can tell them apart.
  const agentFiles = {
    [ALPHA]: {
      "CLAUDE.md": "# Alpha instructions\n",
      "docs/AGENTS.md": "# Alpha docs\n",
      ".claude/skills/alpha-skill/SKILL.md": "---\nname: alpha-skill\ndescription: Alpha's own skill.\n---\n# Alpha skill body\n",
      // The same skill for Codex: one row, both harnesses.
      ".agents/skills/alpha-skill/SKILL.md": "---\nname: alpha-skill\ndescription: Alpha's own skill.\n---\n# Alpha skill body\n",
      ".claude/settings.json": JSON.stringify({ permissions: { allow: ["Bash(ls:*)"] }, env: { TOKEN: "alpha-secret-value" } }),
      ".codex/config.toml": 'model = "gpt-5"\n',
      ".gitattributes": "gen/** linguist-generated=true\n",
      "gen/CLAUDE.md": "# Rendered elsewhere\n",
    },
    // About 2,000 tokens: low against the startup bands, medium against the on-demand ones.
    [BETA]: { "AGENTS.md": `# Beta instructions\n${"Beta guidance line.\n".repeat(400)}` },
  };
  for (const [name, title] of [[ALPHA, "Alpha"], [BETA, "Beta"]]) {
    fx.repository(name, {
      ...agentFiles[name],
      ...Object.fromEntries(["high", "low"].map((level) => [`plans/active/${level}.md`, [
        "---", `id: ${name}-${level}`, "next_action: Check the scope", "---", "",
        `# ${title} ${level} plan`, "", "## Summary", "", "Scope fixture.", "",
      ].join("\n")])),
    });
  }
});
test.afterAll(() => removeFixtureContents(fx));
test.beforeEach(async ({ page }) => {
  for (const name of [ALPHA, BETA]) await addRepositorySource(page, path.join(fx.tmp, name));
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

test("a plan's repo badge applies that repo's filter, and is inert once any repo filter is set", async ({ page }) => {
  await page.goto("/plans");
  const betaCard = page.locator("plan-card", { hasText: "Beta high plan" });
  const badge = betaCard.locator(".repo-badge");
  await expect(badge).toHaveAttribute("href", `/plans?repo=${BETA}`);
  // Hovering the badge takes the hover away from the card's open-the-plan area around it.
  const title = betaCard.locator(".title-link");
  await betaCard.locator(".description-line").hover();
  await expect(title).toHaveCSS("text-decoration-line", "underline");
  await badge.hover();
  await expect(title).toHaveCSS("text-decoration-line", "none");
  await expect(badge).toHaveCSS("text-decoration-line", "none");
  await expect(badge).toHaveCSS("cursor", "pointer");
  // Filtering from a scrolled board starts the filtered board at the top.
  await page.setViewportSize({ width: 1200, height: 300 });
  await badge.scrollIntoViewIfNeeded();
  await page.evaluate(() => window.scrollBy(0, 200));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await badge.click();
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
  await expect(page).toHaveURL(new RegExp(`/plans\\?repo=${BETA}$`));
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${BETA}`);
  await expect(page.getByText("Alpha high plan")).toHaveCount(0);
  // The badge does not open the plan drawer.
  await expect(page.locator("dialog#drawer[open]")).toHaveCount(0);

  const scopedBadge = page.locator("plan-card", { hasText: "Beta high plan" }).locator(".repo-badge");
  await expect(scopedBadge).toHaveAttribute("aria-disabled", "true");
  await expect(scopedBadge).not.toHaveAttribute("href", /.*/);
  // Inert, it still takes the hover away from the card, shows no click affordance, and does nothing.
  const scopedCard = page.locator("plan-card", { hasText: "Beta high plan" });
  const scopedTitle = scopedCard.locator(".title-link");
  await scopedCard.locator(".description-line").hover();
  await expect(scopedTitle).toHaveCSS("text-decoration-line", "underline");
  await scopedBadge.hover();
  await expect(scopedTitle).toHaveCSS("text-decoration-line", "none");
  await expect(scopedBadge).toHaveCSS("cursor", "default");
  await scopedBadge.click();
  await expect(page.locator("dialog#drawer[open]")).toHaveCount(0);

  await page.goBack();
  expect(scopeParam(page)).toBe(null);
  await expect(page.locator("plan-card", { hasText: "Alpha high plan" }).locator(".repo-badge")).toHaveAttribute("href", `/plans?repo=${ALPHA}`);
});

test("changing the scope keeps Plans filters, and back, forward, and deep links restore it", async ({ page }) => {
  await page.goto(`/plans?repo=${ALPHA}`);
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Beta high plan")).toHaveCount(0);
  await page.getByRole("button", { name: "Filters" }).click();
  await page.getByLabel("Search", { exact: true }).fill("high");
  await page.locator("#filters-update").click();
  await expect(page.getByText("Alpha low plan")).toHaveCount(0);

  // Choosing a repo from a scrolled page starts the scoped page at the top.
  await page.setViewportSize({ width: 1200, height: 300 });
  await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
  expect(await page.evaluate(() => window.scrollY)).toBeGreaterThan(0);
  await chooseScope(page, BETA);
  await expect(page).toHaveURL(new RegExp(`/plans\\?repo=${BETA}$`));
  await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(0);
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

const inspectorSection = (page, heading) => page.locator(".repo-inspector-section").filter({ has: page.getByRole("heading", { name: heading }) });

test("scoped Agents shows the repo's token use and its own files read-only, with rendered previews", async ({ page }) => {
  await page.goto(`/agents?repo=${ALPHA}`);
  await expect(page.getByRole("heading", { name: `Token Use for ${ALPHA}` })).toBeVisible();
  await expect(page.locator(".repo-usage-grid [role=columnheader]")).toContainText(["Harness", "Repo Usage", "Total Usage"]);
  await expect(page.getByRole("heading", { name: "Agent Config" })).toBeVisible();
  // The machine-wide grid, the checkout path, and the branch are gone.
  await expect(page.getByRole("heading", { name: "Active Harnesses" })).toHaveCount(0);
  await expect(page.locator("main")).not.toContainText(fx.tmp);
  await expect(page.locator(".repo-inspector-section h2")).toHaveText(["Rules", "Config and hooks", "Skills"]);

  // Rules split into Repo Root and Conditional, each row named by its path in the repo.
  const rules = inspectorSection(page, "Rules");
  await expect(rules.locator(".repo-inspector-group-name")).toHaveText(["Repo Root", "Conditional"]);
  await expect(rules.locator(".repo-inspector-group").first().getByRole("button", { name: "CLAUDE.md", exact: true })).toBeVisible();
  await expect(rules.locator(".repo-inspector-group").nth(1).getByRole("button", { name: "docs/AGENTS.md", exact: true })).toHaveCount(1);
  await expect(rules.locator(".repo-inspector-entry").first().locator("token-chip")).toBeVisible();
  // Rows carry no tags at all.
  await expect(page.locator(".repo-inspector-section .badge")).toHaveCount(0);
  const skills = inspectorSection(page, "Skills");
  await expect(skills.getByRole("button", { name: "alpha-skill" })).toHaveCount(1);
  await expect(skills).toContainText("Alpha's own skill.");
  await expect(skills.locator("li")).toHaveCount(0);
  // Config and hooks groups by harness, which replaces per-row harness tags.
  const config = inspectorSection(page, "Config and hooks");
  await expect(config.locator(".repo-inspector-group-name")).toHaveText(["Claude Code", "Codex"]);
  await expect(config).toContainText("Permissions: 1 allow rules");
  await expect(config.getByRole("button", { name: ".codex/config.toml" })).toBeVisible();
  // Generated files are left off the page.
  await expect(page.locator("main")).not.toContainText("gen/CLAUDE.md");
  await expect(page.locator("main")).not.toContainText("alpha-secret-value");
  await expect(page.locator("main")).not.toContainText("Beta instructions");
  // Repo files are read-only: no package actions on repo skills, no editing on repo permissions.
  await expect(page.locator(".repo-inspector-section config-toggle")).toHaveCount(0);
  await expect(page.locator(".repo-inspector-section .bucket-btn")).toHaveCount(0);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toHaveCount(0);

  // Markdown renders, and the popup names the file's location and Git status.
  await rules.getByRole("button", { name: "CLAUDE.md", exact: true }).click();
  const dialog = page.locator("dialog#config-modal");
  await expect(dialog).toBeVisible();
  await expect(dialog.locator("#modal-content h1")).toHaveText("Alpha instructions");
  await expect(dialog.locator("#modal-path")).toContainText("CLAUDE.md");
  await expect(dialog.locator("#modal-path")).toContainText("Tracked in Git");
  await page.keyboard.press("Escape");

  // Config shows its keys and safe values, never a secret.
  await config.getByRole("button", { name: ".claude/settings.json" }).click();
  await expect(dialog.locator("#modal-content .config-tree")).toContainText("Bash(ls:*)");
  await expect(dialog.locator("#modal-content .config-tree")).toContainText("TOKEN");
  await expect(dialog.locator("#modal-content")).not.toContainText("alpha-secret-value");
  await page.keyboard.press("Escape");

  // A skill opens the global page's skill view, listing both harnesses' copies.
  await skills.getByRole("button", { name: "alpha-skill" }).click();
  await expect(dialog.locator("#modal-content .skill-source-view")).toContainText("Alpha skill body");
  await expect(dialog.locator("#modal-path")).toContainText(".claude/skills/alpha-skill/SKILL.md");
  await expect(dialog.locator("#modal-path")).toContainText(".agents/skills/alpha-skill/SKILL.md");
  await expect(dialog.locator("#modal-cost-row")).toContainText("Startup:");
  await expect(dialog.locator("#modal-cost-row")).toContainText("When run:");
  await page.keyboard.press("Escape");

  // View Global Config clears the repo filter, as All repos does.
  await page.getByRole("button", { name: "View Global Config" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(selector(page)).toHaveAccessibleName("Repo: All repos");
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
  await expect(page.getByRole("heading", { name: /^Token Use for / })).toHaveCount(0);
});

test("scoped Agents sizes a root AGENTS.md as startup context, though Claude reads it only conditionally", async ({ page }) => {
  await page.goto(`/agents?repo=${BETA}`);
  const rootGroup = inspectorSection(page, "Rules").locator(".repo-inspector-group").first();
  await expect(rootGroup.locator(".repo-inspector-group-name")).toHaveText("Repo Root");
  const row = rootGroup.locator(".repo-inspector-entry").filter({ has: page.getByRole("button", { name: "AGENTS.md", exact: true }) });
  await expect(row).toHaveCount(1);
  await expect.poll(() => row.locator("token-chip").evaluate((chip) => chip.level)).toBe("low");
  await row.getByRole("button", { name: "AGENTS.md", exact: true }).click();
  const costRow = page.locator("dialog#config-modal #modal-cost-row");
  await expect(costRow).toContainText("Startup:");
  await expect(costRow).not.toContainText("When loaded:");
  await page.keyboard.press("Escape");
});

test("scoped Agents says when the scan is partial or an active harness is unsupported, and never shows another checkout's files", async ({ page }) => {
  // An unsupported harness that is not active goes unmentioned.
  await page.goto(`/agents?repo=${ALPHA}`);
  await expect(inspectorSection(page, "Rules")).toBeVisible();
  await expect(page.locator("main")).not.toContainText("Gemini");
  // Real inventory, marked partial, with Gemini active: the notices come from the response.
  await page.route((url) => url.pathname === "/api/config/repository", async (route) => {
    const response = await route.fetch();
    const data = await response.json();
    const providers = data.providers.map((provider) => (provider.id === "gemini" ? { ...provider, enabled: true } : provider));
    await route.fulfill({ response, json: { ...data, providers, truncated: ["files"] } });
  });
  await page.goto(`/agents?repo=${ALPHA}`);
  const notices = page.locator(".repo-inspector-notices");
  await expect(notices).toContainText("Partial results: the scan hit its limit on files listed.");
  await expect(notices).toContainText("Not inspected yet: Gemini CLI.");
  await page.unrouteAll({ behavior: "ignoreErrors" });

  // The server's checkout-unavailable answer: a splash, no files, and a way back to global Agents.
  await page.route((url) => url.pathname === "/api/config/repository", (route) => route.fulfill({ json: {
    status: "checkout-unavailable", reason: "ambiguous", message: "More than one checkout is marked primary.", providers: [],
  } }));
  await page.goto(`/agents?repo=${BETA}`);
  const splash = page.locator(".page-splash");
  await expect(splash.getByRole("heading", { name: "Primary checkout unavailable" })).toBeVisible();
  await expect(splash).toContainText("More than one checkout is marked primary. Files from other checkouts are not shown in its place.");
  await expect(page.locator(".repo-inspector-section")).toHaveCount(0);
  await splash.getByRole("button", { name: "View Global Config" }).click();
  await expect(page).toHaveURL(/\/agents$/);
  await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
});

// Holds matching requests until `release()`: `reached` settles when one is held, `continued` once
// it has been let through (or dropped, when its route was removed meanwhile).
async function holdRequests(page, matches) {
  let release;
  let reached;
  let continued;
  const gate = new Promise((resolve) => { release = resolve; });
  const reachedPromise = new Promise((resolve) => { reached = resolve; });
  const continuedPromise = new Promise((resolve) => { continued = resolve; });
  await page.route(matches, async (route) => {
    reached();
    await gate;
    try {
      await route.continue();
    } catch {
      // The route was removed while held; the request never reaches the page.
    }
    continued();
  });
  return { release, reached: reachedPromise, continued: continuedPromise };
}

// One full task turn in the page, so a response that just arrived has been handled.
function settle(page) {
  return page.evaluate(() => new Promise((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0))));
}

test("switching repos while an inventory or preview is pending shows only the current repo", async ({ page }) => {
  // Hold Alpha's responses until after the switch, so they arrive late.
  const preview = await holdRequests(page, (url) => url.pathname.startsWith("/api/config/repository") && url.searchParams.get("repo") === ALPHA && url.searchParams.has("id"));
  // The open preview covers the selector, so this switch comes from browser history.
  await page.goto(`/agents?repo=${BETA}`);
  await expect(inspectorSection(page, "Rules")).toContainText("AGENTS.md");
  await chooseScope(page, ALPHA);
  await inspectorSection(page, "Rules").getByRole("button", { name: "CLAUDE.md", exact: true }).click();
  await expect(page.locator("dialog#config-modal")).toBeVisible();
  await preview.reached;
  await page.goBack();
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${BETA}`);
  await expect(page.locator("dialog#config-modal")).toBeHidden();
  await expect(inspectorSection(page, "Rules")).toContainText("AGENTS.md");

  await page.unrouteAll({ behavior: "ignoreErrors" });
  const inventory = await holdRequests(page, (url) => url.pathname === "/api/config/repository" && url.searchParams.get("repo") === ALPHA);
  await chooseScope(page, ALPHA);
  await expect(page.getByText("Reading this repo's agent files…")).toBeVisible();
  await inventory.reached;
  await chooseScope(page, BETA);
  await expect(inspectorSection(page, "Rules")).toContainText("AGENTS.md");
  const lateInventory = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return url.pathname === "/api/config/repository" && url.searchParams.get("repo") === ALPHA;
  });
  preview.release();
  inventory.release();
  // Alpha's late answers land after Beta's view; neither may replace it.
  await Promise.all([preview.continued, inventory.continued]);
  await (await lateInventory).finished();
  await settle(page);
  await expect(page.locator("main")).not.toContainText("Alpha instructions");
  await expect(page.locator("main")).not.toContainText("alpha-skill");
  await expect(page.locator("dialog#config-modal")).toBeHidden();
  await expect(selector(page)).toHaveAccessibleName(`Repo: ${BETA}`);
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
      warningCount: 3,
      warnings: Array.from({ length: 3 }, (_, index) => ({ kind: "spike", model: "gpt-5-codex", at: "2026-09-24T12:00:00.000Z", severity: "high", sessionId: `s${index}`, harness: "codex" })),
    } };
  });
  await page.goto("/");
  // The link lives in the Tokens shortcut's hover panel.
  await roboRepoCard(page).locator(".repository-shortcut.is-warning .repository-shortcut-link").hover();
  await roboRepoCard(page).getByRole("link", { name: "all activity", exact: true }).click();
  await expect(page).toHaveURL(/\/tokens\?repo=[a-z0-9-]+$/);
  await expect(selector(page)).toHaveAccessibleName("Repo: RoboRepo");
});

test("Plans filters draft in a popup: Update stays disabled until something changes, Cancel discards", async ({ page }) => {
  await page.goto("/plans");
  await expect(page.getByText("Alpha high plan")).toBeVisible();
  await expect(page.getByText("Monitoring")).toHaveCount(0);
  // Filters and Import Plan end the lifecycle row, with Refresh beside the title; no row of their own
  // above it.
  const bar = await page.locator("#lifecycle-bar").boundingBox();
  const toggle = await page.locator("#filters-toggle").boundingBox();
  const add = await page.locator("#plan-import-toggle").boundingBox();
  expect(toggle.x + toggle.width).toBeLessThanOrEqual(add.x);
  expect(Math.abs(add.x + add.width - bar.x - bar.width)).toBeLessThanOrEqual(1);
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
