import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { codexHookGuidance } from "../../harnesses/codex/hook-guidance.mjs";
import { buildBehaviorView } from "../../cli/config.mjs";

// The header bar holds the primary pages; the secondary ones live only in its ⋮ menu, and below
// the narrow breakpoint the menu holds every page.
const NAV_PRIMARY = ["Repos", "Agents", "Plans", "Tokens"];
const NAV_SECONDARY = ["Runtime", "Settings"];
const NAV_ORDER = [...NAV_PRIMARY, ...NAV_SECONDARY];
const ROUTES = [
  { path: "/", active: "Repos" },
  { path: "/agents", active: "Agents" },
  { path: "/plans", active: "Plans" },
  { path: "/tokens", active: "Tokens" },
  { path: "/runtime", active: "Runtime" },
  { path: "/settings", active: "Settings" },
];

test.describe("Agents page", () => {
  test("a package with several skills opens a contents view; each entry opens its source and Back returns", async ({ page }) => {
    await page.goto("/agents");
    const suite = page.locator("config-item").filter({ has: page.locator(".item-label", { hasText: /^Development Planning Lifecycle$/ }) });
    await expect(suite).toHaveCount(1);
    await expect(suite.locator(".badge", { hasText: /^6 skills$/ })).toBeVisible();

    await suite.locator(".item-label").click();
    const modal = page.locator("dialog#config-modal");
    await expect(modal).toBeVisible();
    await expect(modal.locator("#modal-title")).toHaveText("Development Planning Lifecycle");
    await expect(modal.locator(".package-contents-summary")).toHaveText("6 skills · 1 rules fragment");
    await expect(modal.locator(".package-contents-label")).toHaveText(["/plan-write", "/plan-promote", "/plan-execute", "/plan-review", "/plan-close", "/plan-archive", "Rules"]);
    // Every row shows its own cost: a skill's when-loaded size, the rules fragment's startup size.
    const chips = modal.locator(".package-contents-entry token-chip");
    await expect(chips).toHaveCount(7);
    for (const chip of await chips.all()) {
      await expect(chip).toBeVisible();
      expect(await chip.evaluate((el) => el.tokens)).toBeGreaterThan(0);
    }
    await expect(modal.locator("#modal-back")).toBeHidden();
    await expect(modal.locator(".package-contents-entry", { hasText: "Rules" }).locator(".package-contents-desc")).toHaveText("Code Outlives Plans");

    await modal.locator(".package-contents-entry", { hasText: "/plan-execute" }).click();
    await expect(modal.locator("#modal-title")).toHaveText(/plan-execute/);
    await expect(modal.locator("#modal-path")).toContainText("plan-execute/SKILL.md");
    await expect(modal.locator("#modal-back")).toBeVisible();

    await modal.locator("#modal-back").click();
    await expect(modal.locator("#modal-title")).toHaveText("Development Planning Lifecycle");
    await expect(modal.locator(".package-contents-entry")).toHaveCount(7);
    await expect(modal.locator("#modal-back")).toBeHidden();

    await modal.locator(".package-contents-entry", { hasText: "Rules" }).click();
    await expect(modal.locator("#modal-content")).toContainText("Code Outlives Plans");
    await modal.locator("#modal-close").click();
    await expect(modal).not.toBeVisible();
  });

  test("a package with one skill keeps its command label and opens its source directly", async ({ page }) => {
    await page.goto("/agents");
    const single = page.locator("config-item").filter({ has: page.locator(".item-label", { hasText: /^\/session-close$/ }) });
    await expect(single).toHaveCount(1);
    await expect(single.locator(".badge", { hasText: /skills$/ })).toHaveCount(0);
    await single.locator(".item-label").click();
    const modal = page.locator("dialog#config-modal");
    await expect(modal.locator("#modal-path")).toContainText("session-close/SKILL.md");
    await expect(modal.locator(".package-contents")).toHaveCount(0);
    await expect(modal.locator("#modal-back")).toBeHidden();
    await modal.locator("#modal-close").click();
  });

  test("keeps the high token-use banner hidden", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    const activeItem = snapshot.behaviorView.flatMap((section) => section.items || []).find((item) => item.active);
    expect(activeItem, "fixture needs an active Agents item").toBeTruthy();
    activeItem.contextCost = { onDemandTokens: 30000, onDemandLevel: "high" };
    snapshot.contextCost = { ...snapshot.contextCost, onDemandThresholds: { mediumAt: 1000, highAbove: 10000 } };
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      harnesses: {
        supported: [{ id: "claude", displayName: "Claude Code" }, { id: "codex", displayName: "Codex" }],
        detected: [],
        active: [],
      },
    } }));
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));

    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
    await expect(page.locator(".packages-intro p")).toHaveText("Extend your harness config. Toggling a package below writes it into every active harness's configuration.");
    // Settings owns the token telemetry toggle; the Agents page does not repeat it.
    await expect(page.getByText("Token Telemetry", { exact: true })).toHaveCount(0);
    await expect(page.getByText("Monitoring", { exact: true })).toHaveCount(0);
    await expect(page.getByText("The following elements have a high token use:", { exact: true })).toHaveCount(0);
    await expect(page.locator("#main [data-slot=supported]")).toHaveText("Supported Harnesses: Claude Code, Codex");
    await expect(page.getByRole("button", { name: "Check for harnesses" })).toHaveAttribute("data-btn", "cta");
    const warningButtonGrid = await page.getByRole("button", { name: "Check for harnesses" }).evaluate((button) => ({
      column: getComputedStyle(button.parentElement).gridColumn,
      row: getComputedStyle(button.parentElement).gridRow,
    }));
    expect(warningButtonGrid.column).toBe("2");
    expect(warningButtonGrid.row).toBe("1");
  });

  test("required packages are a reference in the package's popup, not page rows; recommended ones are switchable rows", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    const byId = new Map(snapshot.packages.map((pkg) => [pkg.id, pkg]));
    const planSuite = byId.get("plan-suite");
    const sessionClose = byId.get("session-close");
    const dependency = byId.get("technical-writing");
    const companion = byId.get("tighten");
    expect(planSuite && sessionClose && dependency && companion, "fixture packages exist").toBeTruthy();
    // The edges a dependency-only package would add: one dependency shared by two rows, and one
    // recommendation that is off.
    planSuite.requires = ["technical-writing"];
    sessionClose.requires = ["technical-writing"];
    sessionClose.recommends = ["tighten"];
    Object.assign(dependency, {
      selectable: false, selection: "required", enabled: true,
      presentation: { ...dependency.presentation, visibility: "dependency" },
    });
    Object.assign(companion, { enabled: false, selection: "off" });
    snapshot.behaviorView = buildBehaviorView(snapshot);
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));

    await page.goto("/agents");
    const section = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: "Development Workflows" }) });
    // The dependency-only package has no row anywhere on the page.
    await expect(page.locator("config-item").filter({ has: page.getByText(dependency.label, { exact: true }) })).toHaveCount(0);
    await expect(page.getByText("Required dependencies")).toHaveCount(0);

    const recommendedRow = section.locator("[data-slot=recommended-group] config-item");
    await expect(recommendedRow).toHaveCount(1);
    await expect(recommendedRow.locator("[data-slot=relation]")).toHaveText(`recommended by ${sessionClose.label}`);
    await expect(recommendedRow.locator("config-toggle")).toHaveCount(1);

    // A package's popup lists what it requires; each name opens that package's source, and Back
    // returns to the package that requires it.
    const modal = page.locator("dialog#config-modal");
    await section.locator("config-item").filter({ has: page.locator(".item-label", { hasText: /^\/session-close$/ }) }).locator(".item-label").click();
    await expect(modal.locator("#modal-requires")).toBeVisible();
    await expect(modal.locator(".modal-requires-item")).toHaveText([dependency.label]);
    await modal.locator(".modal-requires-item").click();
    await expect(modal.locator("#modal-path")).toContainText("technical-writing/SKILL.md");
    await expect(modal.locator("#modal-requires")).toBeHidden();
    await modal.locator("#modal-back").click();
    await expect(modal.locator("#modal-path")).toContainText("session-close/SKILL.md");
    await expect(modal.locator(".modal-requires-item")).toHaveText([dependency.label]);
    await modal.locator("#modal-close").click();

    // The contents view of a package with several skills lists them too.
    await section.locator(".item-label", { hasText: /^Development Planning Lifecycle$/ }).click();
    await expect(modal.locator(".modal-requires-item")).toHaveText([dependency.label]);
    await modal.locator("#modal-close").click();

    // A required package with no source to open is listed as plain text, not a button.
    const readOnly = snapshot.behaviorView.find((entry) => entry.categoryId === "skills-dev-lifecycle")
      .items.find((item) => item.id === "session-close");
    readOnly.requires = [{ id: "mcp-only", label: "MCP Only", active: true, inspect: null, contextCost: null, builtIn: true }];
    await page.reload();
    await section.locator("config-item").filter({ has: page.locator(".item-label", { hasText: /^\/session-close$/ }) }).locator(".item-label").click();
    await expect(modal.locator("span.modal-requires-item")).toHaveText("MCP Only");
    await expect(modal.locator("button.modal-requires-item")).toHaveCount(0);
    await modal.locator("#modal-close").click();

    // A package with no requirements shows no Requires line.
    await page.locator(".item-label", { hasText: companion.label }).first().click();
    await expect(modal.locator("#modal-requires")).toBeHidden();
    await modal.locator("#modal-close").click();
  });

  test("a group switch counts only rows it can act on, and hides when none are left", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    const section = snapshot.behaviorView.find((entry) => entry.categoryId === "skills-dev-lifecycle");
    expect(section?.items.length, "fixture needs the Development Workflows rows").toBeGreaterThanOrEqual(2);
    section.bulkToggle = true;
    const [first, ...rest] = section.items;
    Object.assign(first, { active: true, selection: "selected" });
    for (const item of rest) Object.assign(item, { active: true, selection: "required" });
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));
    await page.goto("/agents");
    const panel = page.locator("section.panel").filter({ has: page.getByRole("heading", { name: section.category }) });
    await expect(panel.locator("[data-slot=bulk-label]")).toHaveText("Deselect All");

    // Every row on only through another selection: nothing for the switch to do.
    Object.assign(first, { selection: "required" });
    await page.reload();
    await expect(panel.locator("[data-slot=bulk]")).toBeHidden();
  });

  test("enabling a package with recommendations asks which to enable too, and enables nothing by itself", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    const shown = snapshot.behaviorView.flatMap((section) => section.items || []);
    const [target, second] = shown.filter((item) => item.toggle === "package" && !item.active && item.id !== "telemetry" && item.id !== "tighten");
    expect(target && second, "fixture needs two disabled package rows").toBeTruthy();
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));
    const posts = [];
    await page.route("**/api/config/packages", (route) => {
      posts.push(route.request().postDataJSON());
      const { id } = route.request().postDataJSON();
      route.fulfill({ json: {
        ok: true, message: `enabled: ${id}`, outcomes: [], changedPackageIds: [id], config: snapshot,
        recommendations: id === "tighten" ? [] : [{ id: "tighten", label: "Tighten", description: "Harden code against project patterns." }],
      } });
    });

    await page.goto("/agents");
    const row = page.locator("[data-slot=items] config-item").filter({ has: page.locator(".item-label", { hasText: target.label }) }).first();
    await row.getByRole("checkbox").dispatchEvent("click");
    const dialog = page.locator("dialog#recommendations-modal");
    await expect(dialog).toBeVisible();
    await expect(dialog.locator(".recommendation-label")).toHaveText("Tighten");
    await dialog.getByRole("button", { name: "Continue without" }).click();
    await expect(dialog).not.toBeVisible();
    expect(posts).toEqual([{ id: target.id, enabled: true }]);

    // Enable selected turns on exactly the checked recommendations, each as its own toggle.
    const secondRow = page.locator("[data-slot=items] config-item").filter({ has: page.locator(".item-label", { hasText: second.label }) }).first();
    await secondRow.getByRole("checkbox").dispatchEvent("click");
    await expect(dialog).toBeVisible();
    await dialog.getByRole("button", { name: "Enable selected" }).click();
    await expect.poll(() => posts.length).toBe(3);
    expect(posts.slice(1)).toEqual([{ id: second.id, enabled: true }, { id: "tighten", enabled: true }]);
    await expect(dialog).not.toBeVisible();
  });

  test("explains a package whose pieces were installed outside RoboRepo", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    const shown = new Set(snapshot.behaviorView.flatMap((section) => section.items || []).map((item) => item.id));
    const pkg = snapshot.packages.find((entry) => !entry.enabled && !entry.archived && shown.has(entry.id));
    expect(pkg, "fixture needs a disabled package on the Agents page").toBeTruthy();
    // What the probes report when another tool configured this package's MCP server and status
    // line: two status line components (Claude and Codex) must read as one "status line".
    pkg.status = "external";
    pkg.componentStatus = [
      { type: "mcp", id: "context7", state: "external" },
      { type: "harness-config", id: "claude/statusline.json", state: "external" },
      { type: "harness-config", id: "codex/status-line.json", state: "external" },
    ];
    // Rebuilt by the server's own view builder, so this covers its copy as well as the card.
    snapshot.behaviorView = buildBehaviorView(snapshot);
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));

    await page.goto("/agents");
    const row = page.locator("config-item").filter({ has: page.getByText(pkg.label, { exact: true }) });
    const badge = row.locator(".badge", { hasText: "Installed outside RoboRepo" });
    await expect(badge).toHaveClass(/badge-info/);
    await expect(badge).toHaveAttribute("title", "Found: MCP server context7, status line");
    await expect(row.getByText("external", { exact: true })).toHaveCount(0);
    await expect(row.locator("[data-slot=note]")).toHaveText(
      "Already installed without RoboRepo: MCP server context7, status line. "
        + "Turning this on replaces them with RoboRepo's version and manages them from then on.",
    );
  });

  test("finishes setting up a launched harness without a click", async ({ page }) => {
    const realSnapshot = await (await page.request.get("/api/config")).json();
    const supported = [{ id: "claude", displayName: "Claude Code" }];
    const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed", enabled: true };
    const ready = [{ id: "claude", displayName: "Claude Code", confidence: "confirmed", ready: true, warnings: [] }];
    let setUp = false;
    let checks = 0;
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      harnesses: setUp
        ? { supported, detected: [claude], active: [claude], guidance: [] }
        : { supported, detected: [], active: [], guidance: ready },
    } }));
    // Agents re-renders when its config snapshot changes, so the snapshot follows setup too.
    await page.route("**/api/config", (route) => route.fulfill({ json: {
      ...realSnapshot,
      machineHarnesses: setUp ? [claude] : [],
      machineHarnessGuidance: setUp ? [] : ready,
    } }));
    await page.route("**/api/config/harnesses/refresh", (route) => {
      checks += 1;
      setUp = true;
      return route.fulfill({ json: { ok: true, detected: ["claude"], newlyEnabled: [{ id: "claude", displayName: "Claude Code" }], applied: { ok: true } } });
    });

    await page.goto("/agents");
    await expect(page.locator("#main portal-notice [data-slot=copy]").first()).toHaveText("Claude Code is set up.");
    expect(checks).toBe(1);
  });

  test("puts Active Harnesses above its panel", async ({ page }) => {
    const snapshot = await (await page.request.get("/api/config")).json();
    snapshot.machineHarnesses = [{ id: "claude", enabled: true, confidence: "confirmed" }];
    await page.route("**/api/config", (route) => route.fulfill({ json: snapshot }));
    await page.goto("/agents");
    await expect(page.locator(".config-files-section > h2")).toHaveText("Active Harnesses");
    await expect(page.locator(".config-files-section > .panel")).toBeVisible();
  });
});

test.describe("Tokens without captures", () => {
  test("shows a focused empty page until the first capture", async ({ page }) => {
    let hasCapture = false;
    const demo = await (await page.request.get("/api/tokens/mock")).json();
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      telemetry: { enabled: true, captureAvailable: true },
      harnesses: {
        supported: [{ id: "claude", displayName: "Claude Code" }],
        detected: [{ id: "claude", displayName: "Claude Code", confidence: "confirmed" }],
        active: [{ id: "claude", displayName: "Claude Code", confidence: "confirmed" }],
      },
    } }));
    await page.route("**/api/data", (route) => route.fulfill({
      json: { ...demo, capture_count: hasCapture ? 1 : 0 },
    }));

    await page.goto("/tokens");
    await expect(page.getByRole("heading", { name: "No token data yet" })).toBeVisible();
    await expect(page.locator("#tokens-no-data p")).toContainText("Start a new session and we'll start tracking.");
    await expect(page.locator("#tokenscontent")).toBeHidden();
    await expect(page.locator("#tokensoff")).toBeHidden();

    hasCapture = true;
    await page.reload();
    await expect(page.locator("#tokens-no-data")).toBeHidden();
    await expect(page.locator("#tokenscontent")).toBeVisible();
  });
});

test.describe("hook readiness warning", () => {
  const codex = { id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true };
  const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed", enabled: true };
  const setupWith = (active) => ({
    repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
    harnesses: { supported: [codex, claude], detected: active, active, guidance: [] },
    telemetry: { enabled: false, captureAvailable: false },
  });
  const hook = (event, state) => ({ event, name: event, description: `Records activity at ${event}.`, command: `fixture ${event}`, trust: null, enabled: true, state });
  const group = (owner, label, state, hooks) => ({ owner, label, state, hooks });
  const reviewCommand = "/Applications/ChatGPT.app/Contents/Resources/codex";
  const codexStatus = (state, groups, { reviewRevision = null, launch = true, coreBundle = "hooks" } = {}) => ({
    harness: "codex", displayName: "Codex", supported: true, state, groups, reviewRevision, coreBundle,
    reviewLaunch: { supported: launch },
    guidance: {
      command: reviewCommand,
      review: { executable: reviewCommand, args: [] },
      reviewResolved: "These updates will be applied to your next ChatGPT/Codex session.",
      review_required: "Review the listed RoboRepo hooks in Codex and trust only those. Newly trusted hooks run from the next Codex session.",
      preferredInterface: "cli",
      reviewApp: null,
      inactive: "In the ChatGPT desktop app, open Settings → Hooks and turn the listed RoboRepo hooks back on, or use /hooks in the Codex CLI.",
      terminalHint: "Or run this command in a terminal. Codex shows Hooks need review when it starts:",
      missingCore: {
        title: "Install RoboRepo’s core hooks for Codex/ChatGPT",
        message: "",
        purposeLabel: "Why?",
        purpose: [{ name: "SessionStart", description: "Checks ~/.codex/skills for unmanaged skill folders." }, { name: "PreToolUse", description: "Applies command permissions and limits build output." }],
        cliSetupLabel: "Set up via CLI",
        cliSetup: ["Install hooks with the same button above.", "Open the Codex CLI.", "Approve only the pending RoboRepo hooks listed here.", "Start a new Codex session."],
        steps: ["Install hooks with the button below.", "Open the Codex CLI.", "Approve only the pending RoboRepo hooks listed here.", "Start a new Codex session."],
        installLabel: "Install hooks",
        manualApprovalStep: "Open the Codex CLI and approve the listed RoboRepo hooks under SessionStart and PreToolUse.",
      },
    },
  });
  const pendingReview = (revision = "rev-1") => codexStatus("review_required", [
    group("core", "Codex core hooks", "active", [hook("PreToolUse", "active")]),
    group("skill-visibility", "Skill visibility", "review_required", [hook("PostToolUse", "review_required")]),
    group("telemetry", "Token Telemetry", "review_required", [hook("SessionStart", "active"), hook("PostToolUse", "review_required")]),
  ], { reviewRevision: revision });
  const allActive = () => codexStatus("active", [group("telemetry", "Token Telemetry", "active", [hook("Stop", "active")])]);
  // pendingReview() after the user trusted every hook it listed.
  const reviewed = () => codexStatus("active", pendingReview().groups.map((g) => ({
    ...g, state: "active", hooks: g.hooks.map((h) => ({ ...h, state: "active" })),
  })));
  const claudeActive = { harness: "claude", displayName: "Claude Code", supported: true, state: "active", groups: [], guidance: null };
  // `byHarness` values may be functions, so a test can change what the next read returns.
  const routeStatuses = async (page, byHarness) => {
    const reads = [];
    await page.route((url) => /\/api\/config\/hooks\/[^/]+\/status$/.test(url.pathname), (route) => {
      const url = new URL(route.request().url());
      const harness = url.pathname.split("/")[4];
      reads.push({ harness, fresh: url.searchParams.get("fresh") === "1" });
      const value = byHarness[harness];
      return route.fulfill({ json: typeof value === "function" ? value() : value });
    });
    return reads;
  };
  const routeLaunch = async (page, reply) => {
    const launches = [];
    await page.route("**/api/config/hooks/*/review", (route) => {
      launches.push(route.request().postDataJSON());
      return route.fulfill({ json: typeof reply === "function" ? reply() : reply });
    });
    return launches;
  };
  const returnToPortal = (page) => page.evaluate(() => document.dispatchEvent(new Event("visibilitychange")));
  const focusAfterScroll = async (button) => {
    await button.scrollIntoViewIfNeeded();
    await button.evaluate((element) => new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => {
      element.focus({ preventScroll: true });
      resolve();
    }))));
  };

  test("CLI-only pending approvals stay out of portal notices and offers", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview();
    current.guidance = codexHookGuidance([{ kind: "executable", source: "cli", resolvedPath: reviewCommand }]);
    const reads = await routeStatuses(page, { codex: () => current });
    const launches = await routeLaunch(page, { launched: true });
    for (const url of ["/settings", "/", "/tokens"]) {
      await page.goto(url);
      await expect.poll(() => reads.length).toBeGreaterThan(0);
      await expect(page.getByText("Codex hooks need review", { exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "Set up via CLI", exact: true })).toHaveCount(0);
    }
    await page.goto("/settings");
    await page.route("**/api/config/packages", (route) => route.fulfill({ json: { ok: true, hookHarnesses: ["codex"] } }));
    await page.locator("#telemetry-toggle").click();
    await expect.poll(() => reads.some(read => read.fresh)).toBe(true);
    await expect(page.getByRole("region", { name: "Hook review" })).toHaveCount(0);
    current = { ...reviewed(), guidance: current.guidance };
    await page.clock.fastForward(2100);
    await returnToPortal(page);
    await expect(page.getByText("Codex hooks reviewed", { exact: true })).toHaveCount(0);
    expect(launches).toHaveLength(0);

    current = { ...pendingReview("cli-offer"), guidance: current.guidance };
    const config = await routeBulkToggleConfig(page);
    await page.route("**/api/config/packages/bulk", (route) => route.fulfill({ json: { ok: true, status: 200, results: [], config, hookHarnesses: ["codex"] } }));
    const section = config.behaviorView.find(entry => entry.bulkToggle);
    await page.goto("/agents");
    const before = reads.length;
    const escaped = section.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect.poll(() => reads.length).toBeGreaterThan(before);
    await expect(page.getByRole("region", { name: "Hook review" })).toHaveCount(0);
  });

  test("CLI-only missing core hooks retain installation without a duplicate CLI tooltip", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = codexStatus("missing", [group("core", "Codex core hooks", "missing", [hook("SessionStart", "missing")])]);
    current.guidance = codexHookGuidance([{ kind: "executable", source: "cli", resolvedPath: reviewCommand }]);
    await routeStatuses(page, { codex: () => current });
    await page.route("**/api/config/hooks/codex/install", route => {
      current = { ...current, state: "review_required", reviewRevision: "cli-core", groups: [group("core", "Codex core hooks", "review_required", [hook("SessionStart", "review_required")])] };
      return route.fulfill({ json: { ok: true, status: current } });
    });
    await page.goto("/settings");
    await expect(page.getByRole("button", { name: "Set up via CLI", exact: true })).toHaveCount(0);
    await page.getByRole("button", { name: "Install hooks", exact: true }).click();
    await expect(page.locator("#hook-readiness")).toBeHidden();
  });

  test("CLI-only missing disabled and unknown hooks still have remedies", async ({ page }) => {
    await page.route("**/api/settings", route => route.fulfill({ json: setupWith([codex]) }));
    let current;
    await routeStatuses(page, { codex: () => current });
    for (const [state, title] of [["missing", "Codex hooks are missing"], ["inactive", "Codex hooks are turned off"], ["unknown", "Codex hook status is unknown"]]) {
      current = codexStatus(state, [group("telemetry", "Token Telemetry", state, [hook("Stop", state), hook("PostToolUse", "review_required")])], { reviewRevision: "cli-mixed" });
      current.guidance = codexHookGuidance([{ kind: "executable", source: "cli", resolvedPath: reviewCommand }]);
      await page.goto("/settings");
      await expect(page.getByText(title, { exact: true })).toBeVisible();
      await expect(page.getByText("Codex hooks need review", { exact: true })).toHaveCount(0);
    }
  });

  test("Settings, Tokens, and Home offer selective review in Codex; Agents does not", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex, claude]) }));
    await routeStatuses(page, { claude: claudeActive, codex: pendingReview() });
    const launches = await routeLaunch(page, { launched: true });

    await page.goto("/settings");
    const notice = page.locator("#hook-readiness portal-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice).toHaveClass(/notice-warning/);
    await expect(notice.locator("[data-slot=title]")).toHaveText("Codex hooks need review");
    await expect(notice.locator("[data-slot=message]")).toContainText("trust only those");
    await expect(notice).not.toContainText("Trust all");
    await expect(notice.locator('[data-slot="app-route"]')).toBeHidden();
    await expect(notice.getByRole("listitem")).toHaveText(["Skill visibility: PostToolUse", "Token Telemetry: PostToolUse"]);
    await expect(notice.getByRole("button", { name: "Open Codex hook review" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Check again" })).toBeHidden();
    await expect(notice.getByRole("button", { name: "Later" })).toHaveCount(0);
    await notice.getByText("Terminal command").click();
    await expect(notice.locator("[data-slot=command]")).toHaveText(reviewCommand);
    // Nothing opens on its own: no modal, no terminal launch without a click.
    await expect(page.locator("dialog[open]")).toHaveCount(0);
    expect(launches).toHaveLength(0);

    await page.goto("/");
    await expect(page.locator("#home-hook-readiness [data-slot=title]")).toHaveText("Codex hooks need review");

    await page.goto("/tokens");
    await expect(page.locator("#tokens-hook-readiness [data-slot=title]")).toHaveText("Codex hooks need review");

    await page.goto("/agents");
    await expect(page.getByRole("heading", { name: "Available Agent Tools" })).toBeVisible();
    await expect(page.getByText("Codex hooks need review")).toHaveCount(0);
    expect(launches).toHaveLength(0);
  });

  test("opening review sends no command, and returning to the portal shows what is left", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview();
    const reads = await routeStatuses(page, { codex: () => current });
    const launches = await routeLaunch(page, { launched: true });

    await page.goto("/settings");
    const mount = page.locator("#hook-readiness");
    await mount.getByRole("button", { name: "Open Codex hook review" }).click();
    await expect(mount.getByRole("status")).toHaveText(/Codex opened in a terminal/);
    expect(launches).toEqual([{}]);

    // The user trusted one hook in Codex and deferred the other.
    current = codexStatus("review_required", [
      group("skill-visibility", "Skill visibility", "active", [hook("PostToolUse", "active")]),
      group("telemetry", "Token Telemetry", "review_required", [hook("PostToolUse", "review_required")]),
    ], { reviewRevision: "rev-2" });
    const before = reads.length;
    await returnToPortal(page);
    await expect(mount.getByRole("listitem")).toHaveText(["Token Telemetry: PostToolUse"]);
    expect(reads.slice(before).every((read) => read.fresh)).toBe(true);

    // Returning after trusting the rest confirms review without another button press.
    current = reviewed();
    await page.clock.fastForward(2100);
    await returnToPortal(page);
    await expect(mount.locator("[data-slot=title]")).toHaveText("Codex hooks reviewed");
    await expect(mount.locator("[data-slot=message]")).toHaveText("These updates will be applied to your next ChatGPT/Codex session.");
    await expect(mount.getByRole("button", { name: "Open Codex hook review" })).toHaveCount(0);
  });

  test("package approval uses the completed checklist and CLI tooltip without requiring core installation", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    const status = pendingReview();
    status.guidance = codexHookGuidance([{ kind: "executable", source: "desktop", resolvedPath: reviewCommand }]);
    status.groups = status.groups.filter((group) => group.owner !== "core");
    Object.assign(status.groups[0].hooks[0], { name: "RoboRepo: skill reference tracking", description: "Observes skill-reference reads after tool calls." });
    Object.assign(status.groups[1].hooks[1], { name: "RoboRepo: telemetry after tool use", description: "Records local usage after a tool finishes." });
    status.groups[1].hooks[0].trust = "managed";
    status.coreBundle = null;
    await routeStatuses(page, { codex: status });
    const launches = await routeLaunch(page, { launched: true });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness");
    await expect(notice.locator('[data-slot="steps"] > li')).toHaveCount(4);
    await expect(notice.locator('[data-slot="message"]')).toContainText("installed by enabled RoboRepo packages");
    await expect(notice.locator('[data-slot="step-install-text"]')).toHaveText("Hooks awaiting review installed.");
    await expect(notice.locator('[data-slot="step-install-text"]')).toHaveCSS("text-decoration-line", "line-through");
    await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeHidden();
    await expect(notice.locator('[data-slot="step-trust-text"]')).toHaveText("Approve 1 Skill visibility package hook; 1 Token Telemetry package hook.");
    await expect(notice.locator('[data-slot="affected"]')).toBeHidden();
    await expect(notice.getByText("Already active", { exact: false })).toHaveCount(0);
    await expect(notice.locator('[data-slot="terminal-option"]')).toBeHidden();
    await expect(notice.getByRole("button", { name: "Check again" })).toBeVisible();
    for (const name of ["Why?", "View Hook Details", "Set up via CLI"]) {
      await expect(notice.getByRole("button", { name, exact: true })).toHaveCSS("font-size", "14px");
    }
    await focusAfterScroll(notice.getByRole("button", { name: "Set up via CLI", exact: true }));
    await expect(page.getByRole("tooltip").getByRole("listitem")).toHaveCount(4);
    await expect(page.getByRole("tooltip").getByRole("listitem").first().locator('[data-slot="description"]')).toHaveCSS("text-decoration-line", "line-through");
    await expect(page.getByRole("tooltip")).not.toContainText("Install hooks with");
    await expect(page.getByRole("tooltip")).not.toContainText("Trust all");
    await expect(page.getByRole("tooltip")).toContainText("Approve 1 Skill visibility package hook; 1 Token Telemetry package hook.");
    await focusAfterScroll(notice.getByRole("button", { name: "View Hook Details", exact: true }));
    await expect(page.getByRole("tooltip")).toContainText("RoboRepo: Token Telemetry PostToolUse");
    await expect(page.getByRole("tooltip")).toContainText("Records local usage after a tool finishes.");
    await expect(page.getByRole("tooltip")).not.toContainText("Adding these hooks");
    await focusAfterScroll(notice.getByRole("button", { name: "Why?", exact: true }));
    await expect(page.getByRole("tooltip")).toContainText("Adding these hooks enable RoboRepo to enable strict behaviors within the harness");
    await expect(page.getByRole("tooltip")).toContainText("RoboRepo: Skill visibility PostToolUse");
    await expect(page.getByRole("tooltip")).toContainText("Observes skill-reference reads after tool calls.");
    await expect(page.getByRole("tooltip")).toContainText("RoboRepo: Token Telemetry PostToolUse");
    await expect(page.getByRole("tooltip")).toContainText("Records local usage after a tool finishes.");
    await expect(page.getByRole("tooltip")).not.toContainText("unmanaged skills");
    await expect(page.getByRole("tooltip")).not.toContainText("telemetry after tool use");
    await expect(page.getByRole("tooltip")).not.toContainText("skill reference tracking");
    expect(launches).toHaveLength(0);
  });

  test("partial package installation completes only the installation of hooks awaiting review", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    const current = codexStatus("missing", [group("telemetry", "Token Telemetry", "missing", [
      hook("PostToolUse", "review_required"), hook("Stop", "missing"),
    ])], { reviewRevision: "partial-installed" });
    current.guidance = codexHookGuidance([{ kind: "executable", source: "desktop", resolvedPath: reviewCommand }]);
    await routeStatuses(page, { codex: current });
    await page.goto("/settings");
    const review = page.locator("#hook-readiness portal-notice").filter({ hasText: "Codex hooks need review" });
    await expect(review.locator('[data-slot="step-install-text"]')).toHaveText("Hooks awaiting review installed.");
    await expect(review.locator('[data-slot="step-trust-text"]')).toHaveText("Approve 1 Token Telemetry package hook.");
    await expect(review.locator('[data-slot="affected"]')).toBeHidden();
    await expect(page.locator("#hook-readiness portal-notice").filter({ hasText: "Codex hooks are missing" })).toContainText("Token Telemetry: Stop");
    await review.getByRole("button", { name: "Set up via CLI" }).evaluate((button) => button.focus({ preventScroll: true }));
    await expect(page.getByRole("tooltip").getByRole("listitem").first()).toContainText("Hooks awaiting review installed.");
  });

  test("mixed pending hooks use one checklist and partial approval leaves only unresolved hooks", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview();
    current.guidance = codexHookGuidance([{ kind: "executable", source: "desktop", resolvedPath: reviewCommand }]);
    current.groups[0].hooks[0].state = "review_required";
    await routeStatuses(page, { codex: () => current });
    await routeLaunch(page, { launched: true });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness portal-notice");
    await expect(notice).toHaveCount(1);
    await expect(notice.locator('[data-slot="message"]')).toContainText("core hooks and hooks installed by enabled packages");
    await expect(notice.locator('[data-slot="steps"] > li')).toHaveCount(4);
    await expect(notice.locator('[data-slot="step-trust-text"]')).toHaveText("Approve 1 Codex core hook; 1 Skill visibility package hook; 1 Token Telemetry package hook.");
    await expect(notice.getByRole("button", { name: "Set up via CLI", exact: true })).toBeVisible();
    await expect(notice.locator('[data-slot="terminal-option"]')).toBeHidden();
    current.groups[0].hooks[0].state = "active";
    current.groups[1].hooks[0].state = "active";
    current.reviewRevision = "only-telemetry";
    await returnToPortal(page);
    await expect(notice.locator('[data-slot="step-trust-text"]')).toHaveText("Approve 1 Token Telemetry package hook.");
    await expect(notice.getByText("Already active", { exact: false })).toHaveCount(0);
  });

  test("a failed launch keeps the copy-command route, and a review finished elsewhere updates in place", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview();
    await routeStatuses(page, { codex: () => current });
    let reply = { launched: false, reason: "launch_failed", error: "open exited 1" };
    await routeLaunch(page, () => reply);

    await page.goto("/settings");
    const mount = page.locator("#hook-readiness");
    await mount.getByRole("button", { name: "Open Codex hook review" }).click();
    await expect(mount.getByRole("status")).toHaveText(/Copy the command below/);
    await expect(mount.locator("[data-slot=command]")).toBeVisible();
    await expect(mount.getByRole("button", { name: "Copy command" })).toBeVisible();

    // Guidance without provider resolved copy falls back to the shared sentence.
    current = { ...reviewed(), guidance: { ...reviewed().guidance, reviewResolved: undefined } };
    reply = { launched: false, reason: "no_review", status: current };
    await mount.getByRole("button", { name: "Open Codex hook review" }).click();
    await expect(mount.locator("[data-slot=title]")).toHaveText("Codex hooks reviewed");
    await expect(mount.locator("[data-slot=message]")).toHaveText("Nothing RoboRepo installed is waiting for review. Newly trusted hooks run from your next Codex session.");
  });

  test("without a tested terminal launcher the notice offers only the command", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, { codex: { ...pendingReview(), reviewLaunch: { supported: false } } });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness portal-notice");
    await expect(notice.getByRole("button", { name: "Copy command" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Open Codex hook review" })).toHaveCount(0);
    await expect(notice.getByRole("button", { name: "Check again" })).toBeVisible();
  });

  test("missing hooks name their remedy and offer no review; review still shows beside them", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, {
      codex: codexStatus("missing", [
        group("core", "Codex core hooks", "missing", [hook("PreToolUse", "missing")]),
        group("skill-visibility", "Skill visibility", "missing", [hook("PostToolUse", "missing")]),
        group("telemetry", "Token Telemetry", "review_required", [hook("PostToolUse", "review_required")]),
      ], { reviewRevision: "rev-1" }),
    });
    await page.goto("/settings");
    const notices = page.locator("#hook-readiness portal-notice");
    await expect(notices).toHaveCount(2);
    const review = notices.filter({ hasText: "Codex hooks need review" });
    await expect(review.getByRole("listitem")).toHaveText(["Token Telemetry: PostToolUse"]);
    await expect(review.getByRole("button", { name: "Open Codex hook review" })).toBeVisible();
    const missing = notices.filter({ hasText: "Install RoboRepo’s core hooks for Codex/ChatGPT" });
    await expect(missing.locator("[data-slot=message]")).toContainText("Turn the package off and back on in Agents");
    await missing.getByRole("button", { name: "Set up via CLI" }).evaluate((button) => button.focus({ preventScroll: true }));
    await expect(page.getByRole("tooltip")).toContainText("Install hooks with the same button above.");
    await expect(missing.locator('[data-slot="affected"]').getByRole("listitem")).toHaveText(["Skill visibility: PostToolUse"]);
    await expect(missing).toContainText("Approve only the pending RoboRepo hooks listed here.");
    await expect(missing).not.toContainText("nothing to review");
    await expect(missing.getByRole("button", { name: "Open Codex hook review" })).toHaveCount(0);
  });

  test("Settings installs missing core hooks before offering Codex review", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = codexStatus("missing", [group("core", "Codex core hooks", "missing", [hook("PreToolUse", "missing")])]);
    await routeStatuses(page, { codex: () => current });
    const installs = [];
    await page.route("**/api/config/hooks/codex/install", async (route) => {
      installs.push(route.request().postDataJSON());
      current = pendingReview("installed-core");
      await route.fulfill({ json: { ok: true, status: current } });
    });
    const launches = await routeLaunch(page, { launched: true });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness");
    const heading = page.getByRole("heading", { name: "Token Activity Tracking", exact: true });
    await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Check again" })).toBeHidden();
    await expect(notice.getByText("Install RoboRepo’s core hooks for Codex/ChatGPT", { exact: true })).toBeVisible();
    await expect(notice.locator('[data-slot="message"]')).toBeHidden();
    await expect(notice.locator('[data-slot="terminal-option"]')).toBeHidden();
    await notice.getByRole("button", { name: "Why?" }).evaluate((button) => button.focus({ preventScroll: true }));
    await expect(page.getByRole("tooltip").locator("b")).toHaveText(["RoboRepo: Codex core hooks PreToolUse"]);
    await expect(page.getByRole("tooltip")).not.toContainText(".claude");
    await expect(page.getByRole("tooltip")).toHaveCSS("padding", "16px 20px");
    expect((await page.getByRole("tooltip").boundingBox()).width).toBeGreaterThan(400);
    await notice.getByRole("button", { name: "Set up via CLI" }).evaluate((button) => button.focus({ preventScroll: true }));
    await expect(page.getByRole("tooltip").getByRole("listitem")).toHaveText([
      "Install hooks with the same button above.", "Open the Codex CLI.",
      "Approve only the pending RoboRepo hooks listed here.", "Start a new Codex session.",
    ]);
    await expect(page.getByRole("tooltip").getByRole("listitem").nth(1)).toHaveCSS("margin-top", "8px");
    await expect(notice.locator('[data-slot="steps"]').getByRole("listitem")).toHaveText([
      "Install hooks with the button below.",
      "Open the Codex CLI.",
      "Approve only the pending RoboRepo hooks listed here.",
      "Start a new Codex session.",
    ], { useInnerText: true });
    expect((await heading.boundingBox()).y).toBeLessThan((await notice.boundingBox()).y);
    expect((await notice.boundingBox()).y).toBeLessThan((await page.locator("#token-tracking-row").boundingBox()).y);
    await notice.getByRole("button", { name: "Install hooks", exact: true }).click();
    await expect(notice.getByText("Codex hooks need review", { exact: true })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Check again" })).toBeHidden();
    expect(installs).toEqual([{}]);
    expect(launches).toHaveLength(0);
    await notice.getByRole("button", { name: "Open Codex hook review" }).click();
    await expect.poll(() => launches.length).toBe(1);
  });

  test("core approval keeps the setup checklist with installation completed after reload", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = codexStatus("missing", [group("core", "Codex core hooks", "missing", [hook("SessionStart", "missing"), hook("PreToolUse", "missing")])]);
    current.guidance.preferredInterface = "desktop";
    current.guidance.missingCore.steps[1] = "In the ChatGPT desktop app, select the anchor icon below the chat prompt (or go to Settings → Hooks).";
    await routeStatuses(page, { codex: () => current });
    await page.route("**/api/config/hooks/codex/install", (route) => {
      current = { ...current, state: "review_required", reviewRevision: "core-review", groups: [group("core", "Codex core hooks", "review_required", [hook("SessionStart", "review_required"), hook("PreToolUse", "review_required")])] };
      return route.fulfill({ json: { ok: true, status: current } });
    });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness");
    for (const name of ["Why?", "Set up via CLI"]) {
      await expect(notice.getByRole("button", { name, exact: true }).locator('[aria-hidden="true"]')).toHaveCount(0);
    }
    await notice.getByRole("button", { name: "Install hooks", exact: true }).click();
    for (const reload of [false, true]) {
      if (reload) await page.reload();
      await expect(notice.locator('[data-slot="title"]')).toHaveText("Install RoboRepo’s core hooks for Codex/ChatGPT");
      await expect(notice.locator('[data-slot="steps"] > li')).toHaveCount(4);
      await expect(notice.locator('[data-slot="step-install-text"]')).toHaveCSS("text-decoration-line", "line-through");
      await expect(notice.locator('[data-slot="install-complete"]')).toBeVisible();
      await expect(notice.locator('[data-slot="step-approve"]')).toContainText("anchor icon");
      await expect(notice).not.toContainText("Trust all");
      await expect(notice.locator('[data-slot="message"]')).toBeHidden();
      await expect(notice.locator('[data-slot="step-trust-text"]')).toHaveText("Approve 2 Codex core hooks.");
      await focusAfterScroll(notice.getByRole("button", { name: "View Hook Details", exact: true }));
      await expect(page.getByRole("tooltip")).toContainText("SessionStart");
      await expect(page.getByRole("tooltip")).toContainText("PreToolUse");
      await expect(page.getByRole("tooltip")).not.toContainText("Adding these hooks");
      await expect(notice.locator('[data-slot="affected"]')).toBeHidden();
      await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeHidden();
      await expect(notice.getByRole("button", { name: "Why?", exact: true })).toBeVisible();
      await expect(notice.locator('[data-slot="terminal-option"]')).toBeHidden();
      await expect(notice.locator('[data-slot="steps"] code')).toHaveText(["Settings → Hooks"]);
      const check = notice.getByRole("button", { name: "Check again" });
      const cliHelp = notice.getByRole("button", { name: "Set up via CLI", exact: true });
      await expect(cliHelp).toBeVisible();
      expect((await check.boundingBox()).x).toBeLessThan((await cliHelp.boundingBox()).x);
      await focusAfterScroll(cliHelp);
      const tooltip = page.getByRole("tooltip");
      await expect(tooltip.getByRole("listitem")).toHaveCount(4);
      await expect(tooltip.getByRole("listitem").first().locator('[data-slot="description"]')).toHaveCSS("text-decoration-line", "line-through");
      await expect(tooltip.getByRole("listitem").first().getByLabel("Completed")).toHaveText("✓");
      await expect(tooltip.getByRole("listitem").nth(1)).toHaveText("Open the Codex CLI.");
      await expect(tooltip.locator("code")).toHaveCount(0);
    }
  });

  test("returning after terminal installation replaces Install hooks with Open Codex hook review", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = codexStatus("missing", [group("core", "Codex core hooks", "missing", [hook("PreToolUse", "missing")])]);
    const reads = await routeStatuses(page, { codex: () => current });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness");
    await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeVisible();
    current = pendingReview();
    await page.clock.fastForward(2100);
    await returnToPortal(page);
    await expect(notice.getByRole("button", { name: "Open Codex hook review" })).toBeVisible();
    await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeHidden();
    await expect(notice.getByRole("button", { name: "Check again" })).toBeHidden();
    expect(reads.some((read) => read.fresh)).toBe(true);
  });

  test("failed core installation keeps its remedy available", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, { codex: codexStatus("missing", [group("core", "Codex core hooks", "missing", [hook("PreToolUse", "missing")])]) });
    await page.route("**/api/config/hooks/codex/install", (route) => route.fulfill({ status: 500, json: { error: "Install failed" } }));
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness");
    await notice.getByRole("button", { name: "Install hooks", exact: true }).click();
    await expect(notice.getByRole("status")).toContainText("Could not install");
    await expect(notice.getByRole("button", { name: "Install hooks", exact: true })).toBeEnabled();
    await notice.getByRole("button", { name: "Set up via CLI" }).evaluate((button) => button.focus({ preventScroll: true }));
    await expect(page.getByRole("tooltip")).toContainText("Install hooks with the same button above.");
  });

  test("one package with a missing hook and an untrusted one shows both", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, {
      codex: codexStatus("missing", [
        group("telemetry", "Token Telemetry", "missing", [hook("PreToolUse", "missing"), hook("PostToolUse", "review_required")]),
      ], { reviewRevision: "rev-mixed" }),
    });
    await page.goto("/settings");
    const notices = page.locator("#hook-readiness portal-notice");
    await expect(notices.filter({ hasText: "Codex hooks need review" }).getByRole("listitem")).toHaveText(["Token Telemetry: PostToolUse"]);
    await expect(notices.filter({ hasText: "Codex hooks are missing" }).getByRole("listitem")).toHaveText(["Token Telemetry: PreToolUse"]);
  });

  test("a failed read or a hook that went missing is never reported as reviewed", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview();
    await routeStatuses(page, { codex: () => current });
    await page.goto("/settings");
    const mount = page.locator("#hook-readiness");
    await expect(mount.locator("[data-slot=title]")).toHaveText("Codex hooks need review");

    // Codex could not be asked: no claim of success, and the pending set is kept.
    current = codexStatus("unknown", [
      group("skill-visibility", "Skill visibility", "unknown", [hook("PostToolUse", "unknown")]),
      group("telemetry", "Token Telemetry", "unknown", [hook("SessionStart", "unknown"), hook("PostToolUse", "unknown")]),
    ]);
    await returnToPortal(page);
    await expect(mount.locator("[data-slot=title]")).toHaveText("Codex hook status is unknown");
    await expect(page.getByText("Codex hooks reviewed")).toHaveCount(0);

    // The hooks were removed rather than trusted.
    current = codexStatus("missing", [
      group("skill-visibility", "Skill visibility", "missing", [hook("PostToolUse", "missing")]),
      group("telemetry", "Token Telemetry", "missing", [hook("SessionStart", "active"), hook("PostToolUse", "missing")]),
    ]);
    await mount.getByRole("button", { name: "Check again" }).click();
    await expect(mount.locator("[data-slot=title]")).toHaveText("Codex hooks are missing");
    await expect(page.getByText("Codex hooks reviewed")).toHaveCount(0);
  });

  test("turned-off hooks point to Codex settings, not to trust review", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, { codex: codexStatus("inactive", [group("telemetry", "Token Telemetry", "inactive", [hook("Stop", "inactive")])]) });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness portal-notice");
    await expect(notice.locator("[data-slot=title]")).toHaveText("Codex hooks are turned off");
    await expect(notice.locator("[data-slot=message]")).toContainText("turn the listed RoboRepo hooks back on");
    await expect(notice.getByRole("button", { name: "Open Codex hook review" })).toHaveCount(0);
  });

  test("says the state is unknown when the harness runtime cannot report", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    await routeStatuses(page, {
      codex: codexStatus("unknown", [group("telemetry", "Token Telemetry", "unknown", [hook("Stop", "unknown")])]),
    });
    await page.goto("/settings");
    const notice = page.locator("#hook-readiness portal-notice");
    await expect(notice.locator("[data-slot=title]")).toHaveText("Codex hook status is unknown");
    await expect(notice.locator("[data-slot=message]")).toContainText("has been opened at least once");
    await expect(notice.locator("[data-slot=affected]")).toBeHidden();
    await expect(notice.getByRole("button", { name: "Open Codex hook review" })).toHaveCount(0);
    await expect(notice.getByRole("button", { name: "Check again" })).toBeVisible();
  });

  test("stays hidden when every hook is active", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex, claude]) }));
    const reads = await routeStatuses(page, { claude: claudeActive, codex: allActive() });
    await page.goto("/settings");
    await expect.poll(() => reads.length).toBe(2);
    await expect(page.locator("#hook-readiness")).toBeHidden();
  });

  test("returning to an active page discovers hooks changed in an external terminal", async ({ page }) => {
    await page.clock.install();
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = allActive();
    const reads = await routeStatuses(page, { codex: () => current });
    await page.goto("/settings");
    await expect.poll(() => reads.length).toBeGreaterThan(0);
    const notice = page.locator("#hook-readiness");
    await expect(notice).toBeHidden();
    current = pendingReview();
    await page.clock.fastForward(2100);
    await returnToPortal(page);
    await expect(notice.getByText("Codex hooks need review", { exact: true })).toBeVisible();
    expect(reads.some((read) => read.fresh)).toBe(true);
  });

  test("asks nothing when no harness is active", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([]) }));
    const reads = await routeStatuses(page, {});
    await page.goto("/settings");
    await expect(page.locator("#telemetry-toggle")).toHaveText("Enable");
    await expect(page.locator("#hook-readiness")).toBeHidden();
    expect(reads).toHaveLength(0);
  });

  test("a hook change refreshes the normal Settings banner without a duplicate offer", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = allActive();
    const reads = await routeStatuses(page, { codex: () => current });
    await page.route("**/api/config/packages", (route) => route.fulfill({ json: { ok: true, hookHarnesses: ["codex"] } }));
    await page.goto("/settings");
    await expect(page.locator("#hook-readiness")).toBeHidden();
    for (const revision of ["rev-1", "rev-1", "rev-2"]) {
      current = pendingReview(revision);
      await page.locator("#telemetry-toggle").click();
      await expect(page.locator("#hook-readiness portal-notice")).toHaveCount(1);
      await expect(page.getByText("Codex hooks need review", { exact: true })).toHaveCount(1);
      await expect(page.getByRole("region", { name: "Hook review" })).toHaveCount(0);
    }
    expect(reads.some((read) => read.fresh)).toBe(true);
  });

  test("a bulk package change on Agents reads once and shows one combined offer", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: setupWith([codex]) }));
    let current = pendingReview("rev-bulk");
    const reads = await routeStatuses(page, { codex: () => current });
    const config = await routeBulkToggleConfig(page);
    await page.route("**/api/config/packages/bulk", (route) => route.fulfill({ json: { ok: true, status: 200, results: [], config, hookHarnesses: ["codex"] } }));
    const section = config.behaviorView.find((entry) => entry.bulkToggle);
    expect(section, "fixture needs a bulk-toggle section").toBeTruthy();
    await page.goto("/agents");
    const escaped = section.category.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect(page.getByRole("region", { name: "Hook review" }).locator("portal-notice")).toHaveCount(1);
    expect(reads.filter((read) => read.fresh)).toHaveLength(1);
    const offer = page.getByRole("region", { name: "Hook review" });
    await expect(offer).toHaveCSS("position", "static");
    expect((await offer.boundingBox()).y).toBeLessThan((await page.getByRole("heading", { name: "Available Agent Tools" }).boundingBox()).y);
    await offer.getByRole("button", { name: "Later" }).click();
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect.poll(() => reads.filter((read) => read.fresh).length).toBe(2);
    await expect(offer.locator("portal-notice")).toHaveCount(0);
    current = pendingReview("rev-bulk-2");
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect(offer.locator("portal-notice")).toHaveCount(1);

    // Review in Codex Settings or a copied terminal command, without using the launcher.
    current = reviewed();
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(page.getByRole("region", { name: "Hook review" }).getByText("Codex hooks reviewed", { exact: true })).toBeVisible();
    expect(reads.filter((read) => read.fresh)).toHaveLength(4);

    current = pendingReview("desktop-last-offer");
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect(offer.locator("portal-notice")).toHaveCount(1);
    current.guidance = codexHookGuidance([{ kind: "executable", source: "cli", resolvedPath: reviewCommand }]);
    await page.getByRole("checkbox", { name: new RegExp(`^${escaped}: (Select|Deselect) All$`) }).dispatchEvent("click");
    await expect(offer.locator("portal-notice")).toHaveCount(0);

  });
});

test.describe("repository-first portal Home", () => {
  test("worktree rows show their state; Stop Server and Delete Worktree live in row menus", async ({ page }) => {
    // Short enough that the card scrolls, so the open dropdown has a page to follow.
    await page.setViewportSize({ width: 1280, height: 420 });
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    const removals = [];
    let removal = { action: "removed" };
    let removalHeld = null; // a promise the next removal response waits on, to observe the busy state
    await page.route("**/api/repositories/*/worktrees/remove", async (route) => {
      removals.push(route.request().postDataJSON());
      await removalHeld;
      await route.fulfill({ json: removal });
    });
    const stops = [];
    await page.route("**/api/repositories/*/worktrees/stop-servers", async (route) => {
      stops.push(route.request().postDataJSON());
      await route.fulfill({ json: { action: "stopped", stopped: 1, reason: null } });
    });
    await patchRoboRepo(page, (repository) => {
      repository.lifecycle = { state: "idle" };
      repository.domains.plans = { status: "available", data: { active: [
        { id: "idle-plan", key: "idle-plan", title: "Idle Story", worktree: "idle-tree", checkoutRootId: "idle-tree", taskCounts: { total: 1, complete: 0 } },
      ], counts: { active: 1, backlog: 0 }, recent: [] } };
      // Ten days behind origin/main: a Git warning on any branch still in progress.
      const drift = { baseBranch: "origin/main", baseBehind: 30, baseMergeBaseAt: Math.floor(Date.now() / 1000) - 10 * 24 * 60 * 60 };
      const worktree = (rootId, branch, state, extra = {}) => ({ rootId, name: branch, worktreeName: rootId, isWorktree: true, worktreeState: state, unmergedCommits: 3, git: { branch, provider: { ok: true } }, ...extra });
      repository.domains.runtime = { status: "available", data: {
        checkouts: [
          { rootId: "main", name: "main", isWorktree: false, git: { branch: "main", provider: { ok: true } } },
          worktree("idle-tree", "feature/idle", "idle", { projectRoot: "/private/trees/a-worktree-with-a-long-name-that-fills-the-dropdown", git: { branch: "feature/idle", dirty: true, ahead: 12, behind: 0, upstream: "origin/feature/idle", ...drift, provider: { ok: true } } }),
          worktree("stale-tree", "feature/stale", "stale", { git: { branch: "feature/stale", shortHead: "abc1234", ...drift, provider: { ok: true } } }),
          worktree("landed-tree", "feature/landed", "landed", { mergedInto: "main", git: { branch: "feature/landed", ...drift, provider: { ok: true } } }),
          worktree("blocked-tree", "feature/blocked", "landed", { worktreeReason: "plan not closed" }),
          worktree("guarded-tree", "feature/guarded", "landed", { worktreeReason: "uncommitted or untracked changes" }),
          worktree("running-tree", "feature/running", "running", { worktreeRunning: true }),
          worktree("app-tree", null, "idle", { projectRoot: "/private/app/runtime-row", git: { detached: true, shortHead: "d19c7b1", provider: { ok: true } } }),
        ],
        worktreeCleanup: null,
      } };
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    await expect(card.locator(".repository-state-badge")).toHaveText("idle");
    // No port says nothing runs; the row does not spell out "idle".
    await expect(cardRows(card).getByText("idle", { exact: true })).toHaveCount(0);
    // Only a worktree no plan claims has a ⋮ cell; a plan's row keeps its actions in its dropdown.
    await expect(planRowOf(card, "Idle Story").locator(".worktree-row-menu")).toBeHidden();
    await expect(checkoutRow(card, "feature/stale").locator(".worktree-row-menu")).toBeVisible();
    await expect(checkoutRow(card, "feature/stale").getByText("stale", { exact: true })).toBeVisible();
    const merged = checkoutRow(card, "feature/landed").getByText("merged", { exact: true });
    await expect(merged).toBeVisible();
    await expect(merged).toHaveAttribute("title", "Merged into main");
    await expect(checkoutRow(card, "feature/landed").locator(".worktree-state-note")).toBeHidden();
    // A listed merged worktree already implies its plan is open, so that guard adds no note.
    await expect(checkoutRow(card, "feature/blocked").getByText("merged", { exact: true })).toBeVisible();
    await expect(checkoutRow(card, "feature/blocked").locator(".worktree-state-note")).toBeHidden();
    await expect(checkoutRow(card, "feature/guarded").getByText("uncommitted or untracked changes")).toBeVisible();
    await expect(checkoutRow(card, "runtime-row (detached)")).toHaveCount(1);
    await expect(card.getByRole("button", { name: /^(Delete|Stop)/ })).toHaveCount(0);
    // A merged row drops the Git warning a branch in progress shows.
    await expect(checkoutRow(card, "feature/stale").locator(".git-drift")).toBeVisible();
    await expect(checkoutRow(card, "feature/landed").locator(".git-drift")).toBeHidden();

    await card.getByRole("button", { name: "Actions for feature/running" }).click();
    await expect(card.getByRole("button", { name: "Stop Server" }).locator('portal-icon[name="stop"]')).toHaveCount(1);
    await expect(card.getByRole("button", { name: "Delete Worktree" }).locator('portal-icon[name="trash"]')).toHaveCount(1);
    // A successful stop re-reads the overview and rebuilds the card with every menu closed. Mark the
    // current card and wait for it to be replaced, or the next menu opens on a card about to vanish.
    await card.evaluate((element) => { element.dataset.beforeStop = ""; });
    await card.getByRole("button", { name: "Stop Server" }).click();
    await expect.poll(() => stops).toEqual([{ branch: "feature/running" }]);
    await expect(page.locator(".repository-card[data-before-stop]")).toHaveCount(0);

    const dialog = page.getByRole("dialog", { name: "Delete worktree" });
    await card.getByRole("button", { name: "Actions for feature/running" }).click();
    await card.getByRole("button", { name: "Delete Worktree" }).click();
    await expect(dialog).toContainText("Something is running in this worktree.");
    // A running worktree's deletion is not routine: the confirmation turns red.
    await expect(dialog.locator("[data-slot=confirm]")).toHaveAttribute("data-btn", "danger");
    await dialog.getByRole("button", { name: "Cancel" }).click();

    await card.getByRole("button", { name: "Actions for feature/stale" }).click();
    await expect(card.getByRole("button", { name: "Stop Server" })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "Delete Worktree" })).toHaveClass(/menu-item-danger/);
    await card.getByRole("button", { name: "Delete Worktree" }).click();
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText("its local branch, feature/stale.");
    await expect(dialog).toContainText("It has 3 commits that were never merged. A backup is kept so you can bring them back.");
    // The archive ref and restore commands sit behind Details, out of the way until asked for.
    const restore = dialog.locator("[data-slot=restore]");
    await expect(restore).toBeHidden();
    await dialog.getByText("Details and how to restore").click();
    await expect(restore).toHaveText("git branch feature/stale refs/roborepo/abandoned/feature/stale-abc1234\ngit worktree add <folder> feature/stale");
    await expect(dialog.getByText("Something is running in this worktree.")).toBeHidden();
    // A stale worktree is routine cleanup: the confirmation stays green.
    await expect(dialog.locator("[data-slot=confirm]")).toHaveAttribute("data-btn", "cta");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
    await card.getByRole("button", { name: "Actions for feature/landed" }).click();
    await card.getByRole("button", { name: "Delete Worktree" }).click();
    await expect(dialog).toContainText("Its changes are already merged into main, so no committed work is lost.");
    await expect(dialog.locator("[data-slot=confirm]")).toHaveAttribute("data-btn", "cta");
    await dialog.getByRole("button", { name: "Cancel" }).click();
    expect(removals).toEqual([]);

    await card.getByRole("button", { name: "Actions for feature/guarded" }).click();
    await card.getByRole("button", { name: "Delete Worktree" }).click();
    await expect(dialog.getByRole("alert")).toContainText("These changes and files cannot be retrieved after deletion.");
    await expect(dialog.locator("[data-slot=confirm]")).toHaveAttribute("data-btn", "danger");
    await expect(dialog).not.toContainText("nothing is lost");
    const deleteBounds = await dialog.getByRole("button", { name: "Delete worktree", exact: true }).boundingBox();
    const dialogBounds = await dialog.boundingBox();
    expect(deleteBounds.y + deleteBounds.height).toBeLessThanOrEqual(dialogBounds.y + dialogBounds.height);
    expect(deleteBounds.y + deleteBounds.height).toBeLessThanOrEqual(420);
    await page.screenshot({ path: "/tmp/worktree-dirty-delete-warning.png" });
    await dialog.getByRole("button", { name: "Delete worktree", exact: true }).click();
    await expect.poll(() => removals).toEqual([{ branch: "feature/guarded", discardChanges: true }]);
    await expect(dialog).toBeHidden();

    removal = { action: "kept", reason: "uncommitted or untracked changes", requiresDiscardConfirmation: true };
    let release;
    removalHeld = new Promise((resolve) => { release = resolve; });
    await card.getByRole("button", { name: "Actions for feature/stale" }).click();
    await card.getByRole("button", { name: "Delete Worktree" }).click();
    const confirm = dialog.locator("[data-slot=confirm]");
    await confirm.click();
    // While the request runs the confirm button spins and every dialog button is disabled.
    await expect(confirm).toBeDisabled();
    await expect(confirm).toHaveAttribute("aria-busy", "true");
    await expect(confirm.locator(".button-spinner")).toHaveCount(1);
    await expect(confirm).toHaveText("Deleting…");
    await expect(dialog.getByRole("button", { name: "Cancel" })).toBeDisabled();
    release();
    removalHeld = null;
    await expect(dialog.getByRole("alert")).toContainText("uncommitted or untracked changes");
    await expect(dialog.locator("[data-slot=error]")).toBeHidden();
    await expect(confirm).toHaveAttribute("data-btn", "danger");
    await expect(confirm).toBeEnabled();
    await expect(confirm).toHaveText("Delete worktree");
    expect(removals.at(-1)).toEqual({ branch: "feature/stale" });
    removal = { action: "removed" };
    await confirm.click();
    await expect(dialog).toBeHidden();
    expect(removals.at(-1)).toEqual({ branch: "feature/stale", discardChanges: true });

    removal = { action: "removed" };
    // The plan's dropdown: one status line, then the same drift warning the row shows.
    const rowWarning = await planRowOf(card, "Idle Story").locator(".git-drift").textContent();
    await card.getByRole("button", { name: "Worktree details for Idle Story" }).click();
    const details = page.locator(".worktree-details");
    await expect(details.getByText("dirty · 12 ahead · 0 behind remote", { exact: true })).toBeVisible();
    // The row prefixes its warning with ⚠; the dropdown puts icons in a gutter instead — GitHub on the
    // status line, a warning glyph on each warning — so every line's text shares one left edge.
    await expect(details.locator(".git-drift")).toHaveText([rowWarning.replace(/^⚠\s*/, "")]);
    await expect(details.locator(".worktree-detail-fact").first().locator("portal-icon")).toHaveAttribute("name", "github");
    await expect(details.locator(".git-drift portal-icon")).toHaveAttribute("name", "warning");
    await expect(details.getByRole("button", { name: "Delete Worktree" })).toHaveClass(/menu-item-danger/);
    // Every dropdown and menu shares one surface.
    const surfaces = await page.evaluate(() => {
      const background = (selector) => getComputedStyle(document.querySelector(selector)).backgroundColor;
      return [background(".menu-button-panel"), getComputedStyle(document.documentElement).getPropertyValue("--popover-bg").trim()];
    });
    expect(surfaces[0]).not.toBe("rgba(0, 0, 0, 0)");
    expect(await page.evaluate((color) => { const probe = document.createElement("div"); probe.style.color = color; document.body.append(probe); const value = getComputedStyle(probe).color; probe.remove(); return value; }, surfaces[1])).toBe(surfaces[0]);
    // A copy confirms in place without changing the panel's width.
    const panel = page.locator(".menu-button-panel");
    const width = (await panel.boundingBox()).width;
    await details.getByRole("button", { name: "Copy worktree path" }).click();
    await expect(details.locator("portal-copy-button[copied]")).toHaveCount(1);
    expect((await panel.boundingBox()).width).toBe(width);
    // The open dropdown scrolls with the page, staying attached to its trigger.
    const trigger = card.getByRole("button", { name: "Worktree details for Idle Story" });
    const gap = async () => (await panel.boundingBox()).y - (await trigger.boundingBox()).y;
    const before = await gap();
    const triggerTop = (await trigger.boundingBox()).y;
    await page.evaluate(() => window.scrollBy(0, 120));
    await expect.poll(async () => Math.round((await trigger.boundingBox()).y)).toBeLessThan(Math.round(triggerTop));
    await expect.poll(async () => Math.round(await gap())).toBe(Math.round(before));
    await expect(page.getByRole("button", { name: "Stop Server" })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Delete Worktree" }).locator('portal-icon[name="trash"]')).toHaveCount(1);
    await page.getByRole("button", { name: "Delete Worktree" }).click();
    await expect(dialog).toContainText('The active plan "Idle Story" is still using this worktree.');
    await expect(dialog).toContainText("The plan's progress recorded in this worktree will no longer be shown in Plans.");
    await expect(dialog.locator("[data-slot=confirm]")).toHaveAttribute("data-btn", "danger");
    // Details start folded each time the dialog opens.
    await expect(dialog.locator("[data-slot=restore]")).toBeHidden();
    await dialog.getByRole("button", { name: "Delete worktree" }).click();
    await expect(dialog).toBeHidden();
    expect(removals).toEqual([
      { branch: "feature/guarded", discardChanges: true },
      { branch: "feature/stale" },
      { branch: "feature/stale", discardChanges: true },
      { branch: "feature/idle", discardChanges: true },
    ]);
    // The deletion's follow-up refresh may still be in flight through the patched route.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("the cleanup notice confirms a folder and turns on the hook, or shows the line for another tool's hook", async ({ page }) => {
    const requests = [];
    let enabled = { action: "installed" };
    let offered = true;
    await page.route("**/api/repositories/*/worktree-cleanup/*", async (route) => {
      const action = new URL(route.request().url()).pathname.split("/").at(-1);
      requests.push({ action, body: route.request().postDataJSON() });
      if (action === "dismiss") offered = false;
      await route.fulfill({ json: action === "enable" ? enabled : { action: "dismissed" } });
    });
    await patchRoboRepo(page, (repository) => {
      repository.domains.runtime = { status: "available", data: {
        checkouts: [
          { rootId: "main", name: "main", isWorktree: false, git: { branch: "main", provider: { ok: true } } },
          { rootId: "tree", name: "feature/tree", worktreeName: "tree", isWorktree: true, worktreeState: "idle", git: { branch: "feature/tree", provider: { ok: true } } },
        ],
        worktreeCleanup: { offered, hook: "absent", hookReason: null, folder: null, folderSource: null, proposedFolder: "/private/trees", dismissed: false },
      } };
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    const notice = card.getByRole("note");
    await expect(notice).toContainText("Automatic worktree cleanup is off");
    const dialog = page.getByRole("dialog", { name: "Turn on automatic cleanup" });
    await notice.getByRole("button", { name: "Turn on automatic cleanup" }).click();
    await expect(dialog.getByRole("textbox", { name: "Worktree folder" })).toHaveValue("/private/trees");
    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(dialog).toBeHidden();
    expect(requests.at(-1)).toEqual({ action: "enable", body: { folder: "/private/trees" } });

    enabled = { action: "foreign hook", hook: "/private/repo/.git/hooks/post-merge", line: "nohup roborepo-cleanup &" };
    await notice.getByRole("button", { name: "Turn on automatic cleanup" }).click();
    await dialog.getByRole("button", { name: "Turn on" }).click();
    await expect(dialog).toContainText("nohup roborepo-cleanup &");
    await dialog.getByRole("button", { name: "Done" }).click();
    await expect(dialog).toBeHidden();

    await notice.getByRole("button", { name: "Dismiss" }).click();
    await expect(card.getByRole("note")).toHaveCount(0);
    expect(requests.at(-1).action).toBe("dismiss");
    // The dismissal's follow-up refresh may still be in flight through the patched route.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

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
    await expect(notStarted.locator(".plan-match-badge")).toHaveText("no worktree");
    await expect(notStarted.locator(".plan-match-badge")).toHaveAttribute("title", "This plan names no worktree");
    const missing = planRowOf(card, "Plan D");
    await expect(missing.locator(".plan-match-badge")).toHaveText("worktree missing");
    await expect(missing.locator(".plan-match-badge")).toHaveAttribute("title", 'No worktree named "gone" exists in this repo');
    for (const row of [notStarted, missing]) {
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
    const warningsHeading = card.getByRole("heading", { name: "Recent Token Warnings" });
    await expect(warningsHeading).toBeVisible();
    await expect(warningsHeading).toHaveAttribute("title", /8 warnings from \d{2}\/\d{2} to \d{2}\/\d{2}/);
    await expect(card.getByRole("list", { name: "Token warnings" }).getByRole("listitem")).toHaveText([
      "3 token spikes and 2 repeated tool loops in gpt-5-codex",
      "3 repeated tool loops in claude-opus-4-8",
    ]);
    // The warnings are this repository's, so the link opens Tokens scoped to it.
    await expect(card.getByRole("link", { name: "all activity", exact: true })).toHaveAttribute("href", /^\/tokens\?repo=[a-z0-9-]+$/);
    await expect(card.locator(".home-domain-row.is-warning")).toHaveCount(1);
    await expect(card.locator(".status-dot")).toHaveCount(0);
  });

  test("a long plan title is middle-truncated to 70 characters with the full title on hover", async ({ page }) => {
    const title = "A very long plan title that keeps going well past the seventy-five character cap, by a fair bit";
    await planFixture(page, (repository) => { repository.domains.plans.data.active[2].title = title; });
    await page.goto("/");
    const button = roboRepoCard(page).locator(".plan-title", { hasText: "A very long" });
    await expect(button).toHaveText("A very long plan title that keeps g…-five character cap, by a fair bit");
    await expect(button).toHaveAttribute("title", title);
    await expect(roboRepoCard(page).locator(".plan-title", { hasText: "Plan A" })).not.toHaveAttribute("title", /./);
    // Short on width, the row moves its controls down rather than wrapping the title in a column.
    await page.setViewportSize({ width: 720, height: 800 });
    const shortTitle = await roboRepoCard(page).locator(".plan-title", { hasText: "Plan A" }).boundingBox();
    expect((await button.boundingBox()).height).toBe(shortTitle.height);
  });

  // Plan A is the worktree-matched plan; the Plans snapshot decides its next action.
  async function routeNextAction(page, plan) {
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      await route.fulfill({ json: { ...data, plans: [{ key: "a", plan: { blockers: [], qa: { decision: null }, taskCounts: { total: 4, complete: 4, remaining: 0 }, ...plan } }] } });
    });
    await page.route("**/api/plans/prompt", (route) => route.fulfill({ json: { prompt: `prompt for ${route.request().postDataJSON().action}` } }));
  }

  test("a worktree plan row shows its next action beside the details toggle and copies its prompt", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await planFixture(page);
    await routeNextAction(page, { lifecycle: "review" });
    await page.goto("/");
    const identity = roboRepoCard(page).locator(".plan-identity").filter({ hasText: "Plan A" });
    // The worktree toggle follows the title, ahead of the completion; the action closes the line.
    await expect(identity.getByRole("button", { name: "Worktree details for Plan A" })).toBeVisible();
    await expect(identity.getByRole("progressbar", { name: "Plan A completion" })).toBeVisible();
    const action = identity.getByRole("button", { name: "Review", exact: true });
    await expect(action).toHaveAttribute("title", "Copy the /plan-review prompt");
    await expect(action).toHaveAttribute("data-btn", "cta");
    await action.click();
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("prompt for plan-review");
    // A row whose worktree has not merged keeps no merged badge to replace.
    await expect(roboRepoCard(page).locator(".worktree-state-badge:visible")).toHaveCount(0);
  });

  for (const complete of [2, 4]) {
    test(`an active plan with ${complete} of 4 tasks checked has no primary action before submission`, async ({ page }) => {
      await planFixture(page);
      await routeNextAction(page, { lifecycle: "active", taskCounts: { total: 4, complete, remaining: 4 - complete } });
      await page.goto("/");
      const row = planRowOf(roboRepoCard(page), "Plan A");
      await expect(row.getByRole("button", { name: "Worktree details for Plan A" })).toBeVisible();
      await expect(row.locator(".plan-next-action")).toHaveCount(0);
    });
  }

  test("plan controls wrap together while the port and links stay at the top", async ({ page }, testInfo) => {
    const title = "A longer plan title for checking row wrapping";
    await planFixture(page, (repository) => { repository.domains.plans.data.active[0].title = title; });
    await routeNextAction(page, { lifecycle: "review" });
    await page.setViewportSize({ width: 1100, height: 800 });
    await page.goto("/");
    const card = roboRepoCard(page);
    const row = planRowOf(card, title);
    const titleButton = row.getByRole("button", { name: title, exact: true });
    const toggle = row.getByRole("button", { name: `Worktree details for ${title}` });
    const progress = row.getByRole("progressbar");
    const action = row.getByRole("button", { name: "Review", exact: true });
    const port = row.getByRole("link", { name: ":5173" });
    const links = row.getByRole("button", { name: "Links", exact: true });
    await expect(action).toBeVisible();
    const wide = await Promise.all([titleButton, toggle, progress, action, port, links, row].map((item) => item.boundingBox()));
    const centerY = (box) => box.y + box.height / 2;
    expect(Math.abs(centerY(wide[0]) - centerY(wide[3]))).toBeLessThan(2);
    await page.screenshot({ path: testInfo.outputPath("plan-row-wide.png") });
    await page.setViewportSize({ width: 720, height: 800 });
    const narrow = await Promise.all([titleButton, toggle, progress, action, port, links, row].map((item) => item.boundingBox()));
    await page.screenshot({ path: testInfo.outputPath("plan-row-wrapped.png") });
    expect(narrow[1].y).toBeGreaterThanOrEqual(narrow[0].y + narrow[0].height);
    expect(Math.abs(centerY(narrow[1]) - centerY(narrow[2]))).toBeLessThan(2);
    expect(Math.abs(centerY(narrow[1]) - centerY(narrow[3]))).toBeLessThan(2);
    expect(narrow[4].y - narrow[6].y).toBeCloseTo(wide[4].y - wide[6].y, 0);
    expect(narrow[5].y - narrow[6].y).toBeCloseTo(wide[5].y - wide[6].y, 0);
    expect(narrow[0].height).toBe(wide[0].height);
  });

  test("a merged worktree's Close action replaces its merged badge", async ({ page }) => {
    await planFixture(page, (repository) => {
      Object.assign(repository.domains.runtime.data.checkouts.find((checkout) => checkout.rootId === "matched"), { worktreeState: "landed", mergedInto: "main" });
    });
    await routeNextAction(page, { lifecycle: "review", qa: { decision: "approved" } });
    await page.goto("/");
    const row = roboRepoCard(page).locator(".repository-root", { has: page.locator(".plan-identity", { hasText: "Plan A" }) });
    const close = row.locator(".plan-next-action");
    await expect(close).toHaveText("Close");
    await expect(close).toHaveAttribute("title", "Merged — copy the /plan-close prompt");
    await expect(row.locator(".worktree-state-badge")).toBeHidden();
  });

  test("a merged worktree keeps its merged badge while its plan still needs review", async ({ page }) => {
    await planFixture(page, (repository) => {
      Object.assign(repository.domains.runtime.data.checkouts.find((checkout) => checkout.rootId === "matched"), { worktreeState: "landed", mergedInto: "main" });
    });
    await routeNextAction(page, { lifecycle: "review" });
    await page.goto("/");
    const row = roboRepoCard(page).locator(".repository-root", { has: page.locator(".plan-identity", { hasText: "Plan A" }) });
    await expect(row.locator(".plan-next-action")).toHaveText("Review");
    await expect(row.locator(".worktree-state-badge")).toHaveText("merged");
  });

  test("the copy dropdown confirms with green checks while keeping item labels", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.clock.install();
    await planFixture(page);
    await page.goto("/");
    const menu = checkoutRow(roboRepoCard(page), "feature/loose").locator("portal-copy-menu");
    await menu.getByRole("button", { name: "Copy", exact: true }).click();
    const item = menu.getByRole("button", { name: "Copy branch name", exact: true });
    await expect(item.locator('portal-icon[name="copy"]')).toBeVisible();
    await item.click();
    const copied = menu.getByRole("button", { name: "Copied", exact: true });
    await expect(copied).toHaveText("Copy branch name");
    await expect(copied.locator('portal-icon[name="check"]')).toBeVisible();
    expect(await copied.evaluate((node) => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ok)";
      node.append(probe);
      const matches = getComputedStyle(node).color === getComputedStyle(probe).color;
      probe.remove();
      return matches;
    })).toBe(true);
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("feature/loose");
    await page.clock.fastForward(600);
    await expect(menu.locator(".copy-menu-panel")).toHaveCount(0);
    await expect(menu.getByRole("button", { name: "Copied", exact: true }).locator('portal-icon[name="check"]')).toBeVisible();
    await page.clock.fastForward(5000);
    await expect(menu.getByRole("button", { name: "Copy", exact: true }).locator('portal-icon[name="copy"]')).toBeVisible();
  });

  test("the worktree details dropdown copies each value in place and lists only non-default facts", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await planFixture(page);
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    const panel = card.locator(".worktree-details");
    // The worktree is identified by its path alone; its name was the path's last segment repeated.
    // The plan path points at the plan's copy inside that worktree.
    await expect(panel.locator(".worktree-detail-value")).toHaveText(["feature/a", "/private/wt/feature-a", "/private/wt/feature-a/docs/plans/active/plan-a.md"]);
    await expect(panel.getByRole("list", { name: "Worktree status" }).getByRole("listitem")).toHaveText([
      "dirty · 0 ahead", "3 behind remote",
    ]);
    for (const name of ["Copy branch name", "Copy worktree path", "Copy plan path"]) {
      await expect(panel.getByRole("button", { name })).toHaveCount(1);
    }
    await expect(panel.getByRole("button", { name: "Copy worktree name" })).toHaveCount(0);

    await panel.getByRole("button", { name: "Copy worktree path" }).click();
    const row = panel.locator(".worktree-detail-row").nth(1);
    await expect(panel).toBeVisible();
    // The value stays put and the button confirms with its check alone, so the panel keeps its width.
    await expect(row.locator("portal-copy-button[copied]")).toHaveCount(1);
    await expect(row).toHaveText("/private/wt/feature-a", { useInnerText: true });
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/private/wt/feature-a");
    // The shared confirmation interval (5 s), then the button returns to idle.
    await expect(row.locator("portal-copy-button[copied]")).toHaveCount(0, { timeout: 8_000 });

    await panel.getByRole("button", { name: "Copy plan path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/private/wt/feature-a/docs/plans/active/plan-a.md");

    // Closing the panel mid-confirmation resets the button, so reopening shows an idle copy button,
    // not a stuck confirmation.
    await panel.getByRole("button", { name: "Copy branch name" }).click();
    await expect(panel.locator(".worktree-detail-row").first().locator("portal-copy-button[copied]")).toHaveCount(1);
    await page.keyboard.press("Escape");
    await expect(panel).toHaveCount(0);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    await expect(panel.locator(".worktree-detail-row").first()).toHaveText("feature/a", { useInnerText: true });
    await expect(panel.getByRole("button", { name: "Copy branch name" })).toBeEnabled();

    await page.keyboard.press("Escape");
    await card.getByRole("button", { name: "Worktree details for Plan B" }).click();
    // Without a resolved worktree path there is no plan path to build, so that row is left out.
    await expect(card.locator(".worktree-details .worktree-detail-value")).toHaveText(["feature/b", "feature-b"]);
    await expect(card.locator(".worktree-details").getByRole("list", { name: "Worktree status" })).toBeHidden();
  });

  test("once a plan's worktree has merged, the plan path points at the main checkout's copy", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await planFixture(page, (repository) => {
      const checkouts = repository.domains.runtime.data.checkouts;
      checkouts.find((checkout) => checkout.rootId === "main").projectRoot = "/private/repo";
      Object.assign(checkouts.find((checkout) => checkout.rootId === "matched"), { worktreeState: "landed", mergedInto: "main" });
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    const panel = card.locator(".worktree-details");
    await expect(panel.locator(".worktree-detail-value")).toHaveText(["feature/a", "/private/wt/feature-a", "/private/repo/docs/plans/active/plan-a.md"]);
    await panel.getByRole("button", { name: "Copy plan path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe("/private/repo/docs/plans/active/plan-a.md");
  });

  test("a merged worktree with no main checkout path shows no plan path rather than the stale worktree copy", async ({ page }) => {
    await planFixture(page, (repository) => {
      Object.assign(repository.domains.runtime.data.checkouts.find((checkout) => checkout.rootId === "matched"), { worktreeState: "landed", mergedInto: "main" });
    });
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Worktree details for Plan A" }).click();
    await expect(card.locator(".worktree-details .worktree-detail-value")).toHaveText(["feature/a", "/private/wt/feature-a"]);
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

    const planPath = `${longPath}/docs/plans/active/plan-a.md`;
    const planValue = card.locator(".worktree-details .worktree-detail-value").nth(2);
    await expect(planValue).toHaveText(/^.{50}$/);
    await expect(planValue).toHaveAttribute("title", planPath);
    await card.getByRole("button", { name: "Copy plan path" }).click();
    expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(planPath);
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
    // These plans carry no worktreeState from the server, so a named worktree reads as unknown.
    await expect(card.locator(".plan-match-badge")).toHaveText(["worktree status unknown", "worktree status unknown", "no worktree", "worktree missing"]);
  });

  test("an unmatched plan's badge names its worktree state", async ({ page }) => {
    let state;
    await planFixture(page, (repository) => { repository.domains.plans.data.active.find((plan) => plan.id === "d").worktreeState = state; });
    for (const [worktreeState, text, title] of [
      ["unlisted", "worktree not listed", 'Worktree "gone" exists, but Runtime does not list it'],
      ["ambiguous", "worktree ambiguous", 'Worktree "gone" is claimed by another active plan or matches more than one checkout'],
      ["unknown", "worktree status unknown", 'Home cannot tell whether worktree "gone" is running'],
    ]) {
      state = worktreeState;
      await page.goto("/");
      const badge = planRowOf(roboRepoCard(page), "Plan D").locator(".plan-match-badge");
      await expect(badge).toHaveText(text);
      await expect(badge).toHaveAttribute("title", title);
    }
  });

  test("Home Links shows only a bare caret, discovers routes and closes with Escape", async ({ page }) => {
    await homeFixture(page);
    await page.route("**/api/developer-runtime/metadata?*", (route) => route.fulfill({ json: { suggestions: [
      { kind: "page", source: "sitemap", path: "/docs" },
      { kind: "api", source: "openapi", method: "GET", path: "/api/example" },
    ] } }));
    await page.goto("/");
    const card = roboRepoCard(page);
    const links = card.getByRole("button", { name: "Links", exact: true });
    await expect(links.locator("portal-icon[name=link]")).toHaveCount(0);
    await expect(links.locator("portal-icon[name=chevron] svg")).toBeVisible();
    await expect(links).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
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
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Install a supported harness to add agent tools and enable token tracking.");
    await expect(banner.locator("[data-slot=supported]")).toHaveText("Supported Harnesses: Claude Code, Codex");
    await expect(banner.getByRole("button", { name: "Check for harnesses" })).toHaveAttribute("data-btn", "secondary");
    const infoButtonGrid = await banner.getByRole("button", { name: "Check for harnesses" }).evaluate((button) => ({
      column: getComputedStyle(button.parentElement).gridColumn,
      row: getComputedStyle(button.parentElement).gridRow,
    }));
    expect(infoButtonGrid.column).toBe("2");
    expect(infoButtonGrid.row).toBe("1");
  });

  test("Home finishes setting up a launched harness without a click and confirms it", async ({ page }) => {
    const supported = [{ id: "claude", displayName: "Claude Code" }, { id: "codex", displayName: "Codex" }];
    const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed", enabled: true };
    let setUp = false;
    let checks = 0;
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: setUp
        ? { supported, detected: [claude], active: [claude], guidance: [] }
        : { supported, detected: [], active: [], guidance: [{ id: "claude", displayName: "Claude Code", confidence: "confirmed", ready: true, warnings: [] }] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    let finishSetup;
    const setupFinished = new Promise((resolve) => { finishSetup = resolve; });
    await page.route("**/api/config/harnesses/refresh", async (route) => {
      checks += 1;
      await setupFinished;
      setUp = true;
      return route.fulfill({ json: { ok: true, detected: ["claude"], newlyEnabled: [{ id: "claude", displayName: "Claude Code" }], applied: { ok: true } } });
    });
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Setting up Claude Code…");
    await expect(banner.locator(".harness-check-spinner")).toBeVisible();
    await expect(banner.getByRole("button")).toHaveCount(0);
    finishSetup();
    await expect(banner).toHaveClass(/notice-success/);
    await expect(banner.locator("[data-notice-icon] portal-icon")).toHaveAttribute("name", "check");
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Claude Code is set up.");
    await expect(banner.getByRole("button")).toHaveCount(0);
    expect(checks).toBe(1);
  });

  test("Home notices a launch while waiting and finishes setup without a reload", async ({ page }) => {
    await page.clock.install();
    const supported = [{ id: "claude", displayName: "Claude Code" }];
    const claude = { id: "claude", displayName: "Claude Code", confidence: "confirmed", enabled: true };
    let launched = false;
    let setUp = false;
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: setUp
        ? { supported, detected: [claude], active: [claude], guidance: [] }
        : { supported, detected: [], active: [], guidance: [launched
          ? { id: "claude", displayName: "Claude Code", confidence: "confirmed", ready: true, warnings: [] }
          : { id: "claude", displayName: "Claude Code", confidence: "probable", warnings: ["Launch Claude Code once, then run roborepo update."] }] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.route("**/api/config/harnesses/refresh", (route) => {
      setUp = true;
      return route.fulfill({ json: { ok: true, detected: ["claude"], newlyEnabled: [{ id: "claude", displayName: "Claude Code" }], applied: { ok: true } } });
    });
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Launch Claude Code once. RoboRepo will finish setting it up.");

    launched = true;
    await page.clock.runFor(10_000);
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Claude Code is set up.");
  });

  test("Home reports a setup that could not finish and does not retry on its own", async ({ page }) => {
    let checks = 0;
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: {
        supported: [{ id: "claude", displayName: "Claude Code" }],
        detected: [],
        active: [],
        guidance: [{ id: "claude", displayName: "Claude Code", confidence: "confirmed", ready: true, warnings: [] }],
      },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.route("**/api/config/harnesses/refresh", (route) => {
      checks += 1;
      return route.fulfill({ json: { ok: true, detected: ["claude"], newlyEnabled: [{ id: "claude", displayName: "Claude Code" }], applied: { ok: false, error: "installer exited 1\nstack" } } });
    });
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner.locator("[data-slot=copy]")).toHaveText("RoboRepo couldn't finish setting up Claude Code. Run roborepo update in a terminal to see why.");
    await expect(banner.locator("[data-slot=result]")).toHaveText("installer exited 1");
    await expect(banner.getByRole("button", { name: "Try again" })).toBeVisible();
    expect(checks).toBe(1);
  });

  test("a harness waiting on the user names it, and a check that finds nothing says why", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 1, visibleCount: 1, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: {
        supported: [{ id: "claude", displayName: "Claude Code" }, { id: "codex", displayName: "Codex" }],
        detected: [],
        active: [],
        guidance: [{ id: "claude", displayName: "Claude Code", confidence: "probable", warnings: ["Launch Claude Code once, then run roborepo update."] }],
      },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.route("**/api/config/harnesses/refresh", (route) => route.fulfill({ json: { ok: true, detected: [], newlyEnabled: [], applied: null } }));
    await page.goto("/");
    const banner = page.locator("#home-harness-banner portal-notice");
    await expect(banner.locator("[data-slot=copy]")).toHaveText("Launch Claude Code once. RoboRepo will finish setting it up.");
    await expect(banner.locator("[data-slot=supported]")).toHaveCount(0);
    await banner.getByRole("button", { name: "Check now" }).click();
    await expect(page.locator("#home-harness-banner [data-slot=result]")).toHaveText("Claude Code hasn't been launched yet.");
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
    await expect(page.locator("#nav .overflow-more-trigger")).toHaveClass(/\bactive\b/);
    await page.locator("#nav .overflow-more-trigger").click();
    await expect(page.locator('#nav-more-panel a[aria-current="page"] portal-icon[name="settings"] svg')).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(page.getByRole("heading", { level: 2, name: "Repos" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Agent Harnesses" })).toBeVisible();
    await expect(page.getByRole("heading", { level: 2, name: "Token Activity Tracking" })).toBeVisible();
    await expect(page.locator("#repository-sources-inline .sources-repositories")).toBeVisible();
    await expect(page.locator("#repository-sources-inline .sources-repositories h3")).toHaveCount(0);
    await expect(page.locator("#repository-sources-inline").getByRole("button", { name: "Auto-discover active repos" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Check for harnesses" })).toHaveAttribute("data-btn", "text");
    const response = page.waitForResponse((res) => res.url().includes("/api/config/harnesses/refresh") && res.request().method() === "POST");
    await page.getByRole("button", { name: "Check for harnesses" }).click();
    await response;
    await expect(page.locator("#harness-list")).toBeVisible();
    await expect(page.getByRole("button", { name: "Disable Codex" })).toBeVisible();
    await expect(page.getByText("Enable token tracking", { exact: false })).toBeVisible();
    await expect(page.getByRole("button", { name: "Enable token tracking" })).toHaveText("Enable");
  });

  test("Settings queues one refresh when another mutation completes during a fetch", async ({ page }) => {
    let settingsRequests = 0;
    let releasePendingSettings;
    const settings = {
      repositories: { knownCount: 0, visibleCount: 0, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: {
        supported: [{ id: "codex", displayName: "Codex" }],
        detected: [{ id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true }],
        active: [{ id: "codex", displayName: "Codex", confidence: "confirmed", enabled: true }],
      },
      telemetry: { enabled: false, captureAvailable: false },
    };
    await page.route("**/api/repositories/sources", (route) => route.fulfill({ json: {
      revision: 1,
      loadError: null,
      autoDiscovery: { id: "auto-discovery", enabled: false, repositoryCount: 0 },
      repositories: [],
      sources: [],
    } }));
    await page.route("**/api/settings", async (route) => {
      settingsRequests += 1;
      if (settingsRequests === 2) await new Promise((resolve) => { releasePendingSettings = resolve; });
      await route.fulfill({ json: settings });
    });
    await page.route("**/api/config/harnesses/codex/enabled", (route) => route.fulfill({ json: { enabled: false } }));
    await page.route("**/api/config/packages", (route) => route.fulfill({ json: { enabled: true } }));

    await page.goto("/settings");
    await page.getByRole("button", { name: "Disable Codex" }).click();
    await expect.poll(() => settingsRequests).toBe(2);
    await page.getByRole("button", { name: "Enable token tracking" }).click();
    await expect.poll(() => releasePendingSettings).toBeTruthy();
    releasePendingSettings();
    await expect.poll(() => settingsRequests).toBe(3);
  });

  test("Settings explains an empty harness catalog and responds to a setup-state error", async ({ page }) => {
    await page.route("**/api/settings", (route) => route.fulfill({ json: {
      repositories: { knownCount: 0, visibleCount: 0, autoDiscoveryEnabled: false, hasConfiguredSources: false },
      harnesses: { supported: [], detected: [], active: [] },
      telemetry: { enabled: false, captureAvailable: false },
    } }));
    await page.goto("/settings");
    await expect(page.getByRole("status").filter({ hasText: "No supported harnesses are registered." })).toBeVisible();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await page.route("**/api/settings", (route) => route.fulfill({
      status: 503,
      contentType: "application/json",
      body: JSON.stringify({ error: "setup service unavailable" }),
    }));
    await page.reload();
    await expect(page.locator("#settings-error")).toHaveText("setup service unavailable");
    await expect(page.locator("#telemetry-toggle")).toBeDisabled();
    await expect(page.getByRole("button", { name: "Check for harnesses" })).toBeEnabled();
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

  test("global navigation keeps primary pages in the bar and the rest in the ⋮ menu", async ({ page }) => {
    await page.goto("/");
    await expect(page.locator("#nav > a")).toHaveText(NAV_PRIMARY);
    const trigger = page.locator("#nav .overflow-more-trigger");
    const panel = page.locator("#nav-more-panel");
    await expect(panel).toBeHidden();
    await trigger.click();
    await expect(trigger).toHaveAttribute("aria-expanded", "true");
    await expect(panel.locator("a:visible")).toHaveText(NAV_SECONDARY);
    // Outside click and Escape both close it; Escape hands focus back to the trigger.
    await page.locator("main").click({ position: { x: 5, y: 5 } });
    await expect(panel).toBeHidden();
    await trigger.click();
    await page.keyboard.press("Escape");
    await expect(panel).toBeHidden();
    await expect(trigger).toBeFocused();
    await expect(trigger).toHaveAttribute("aria-expanded", "false");

    for (const { path, active } of ROUTES) {
      const response = await page.goto(path);
      expect(response.status()).toBe(200);
      const secondary = NAV_SECONDARY.includes(active);
      // A primary page is current in the bar and in the menu's narrow-screen copy; a secondary page
      // is current only in the menu, so the trigger carries the highlight in the bar.
      await expect(page.locator("#nav a.active")).toHaveText(secondary ? [active] : [active, active]);
      if (secondary) await expect(trigger).toHaveClass(/\bactive\b/);
      else await expect(trigger).not.toHaveClass(/\bactive\b/);
    }
  });

  test("a narrow viewport moves every page into the ⋮ menu", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 780 });
    await page.goto("/");
    await expect(page.locator("#nav > a:visible")).toHaveCount(0);
    await page.locator("#nav .overflow-more-trigger").click();
    const links = page.locator("#nav-more-panel a:visible");
    await expect(links).toHaveText(NAV_ORDER);
    const panel = await page.locator("#nav-more-panel").boundingBox();
    expect(panel.x).toBeGreaterThanOrEqual(0);
    expect(panel.x + panel.width).toBeLessThanOrEqual(420);
    await links.filter({ hasText: "Plans" }).click();
    await expect(page).toHaveURL(/\/plans$/);
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
    await page.locator("#nav .overflow-more-trigger").click();
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
    await page.route("**/api/settings", async (route) => {
      const setup = await (await route.fetch()).json();
      setup.harnesses.active = [{ id: "claude", displayName: "Claude Code", enabled: true, confidence: "confirmed" }];
      await route.fulfill({ json: setup });
    });
    // The real hook status depends on the machine's Claude install; a runner without RoboRepo's hooks
    // would put a readiness notice (and its Check again button) ahead of the Enable prompt.
    await page.route("**/api/config/hooks/*/status*", (route) => route.fulfill({
      json: { harness: "claude", displayName: "Claude Code", supported: true, state: "active", groups: [], guidance: null },
    }));
    await page.goto("/");
    await expect(roboRepoCard(page)).toBeVisible();
    await page.keyboard.press("Tab");
    const logo = await focusSummary(page);
    expect(logo.ariaLabel).toBe("roborepo home");
    expect(logo.visible).toBe(true);
    for (const expected of NAV_PRIMARY) {
      await page.keyboard.press("Tab");
      const focused = await focusSummary(page);
      expect(focused.text).toBe(expected);
      expect(focused.visible).toBe(true);
    }
    // The closed ⋮ menu is one stop; its links stay out of the tab order until it opens.
    await page.keyboard.press("Tab");
    const more = await focusSummary(page);
    expect(more.ariaLabel).toBe("More pages");
    expect(more.visible).toBe(true);
    // The compact Enable prompt now sits above the Active Repos section, so its action comes before
    // the title's Manage repositories icon and both come before the first card.
    await page.keyboard.press("Tab");
    const enable = await focusSummary(page);
    expect(enable.text).toBe("Auto-discover active repos");
    expect(enable.visible).toBe(true);
    // Manage Repos is an icon-only link beside the title, so it is named by its aria-label.
    await page.keyboard.press("Tab");
    const manage = await focusSummary(page);
    expect(manage.ariaLabel).toBe("Manage Repos");
    expect(manage.visible).toBe(true);
    await page.keyboard.press("Tab");
    // Repository names are plain text while the detail page is parked, so the first card control is
    // the provider link (when the repository has one) or the actions menu.
    const firstCardControl = await focusSummary(page);
    expect(["GitHub", "Actions"]).toContain(firstCardControl.ariaLabel);
    expect(firstCardControl.visible).toBe(true);
    // Home's harness-banner request for /api/settings is never awaited here, so on a slow runner it
    // can still be in flight through the patched route when the test ends.
    await page.unrouteAll({ behavior: "ignoreErrors" });
  });

  test("repo row exposes the configured Home actions", async ({ page }) => {
    await page.goto("/");
    await roboRepoCard(page).getByRole("button", { name: "Actions" }).click();
    const menu = roboRepoCard(page).locator(".menu-panel");
    await expect(menu.locator("> *")).toHaveText(["All Plans", "Agent Config", "Token Activity", "Pin", "Forget This Repo"]);
    // The page links open each page already filtered to this repo.
    for (const [name, path] of [["All Plans", "/plans"], ["Agent Config", "/agents"], ["Token Activity", "/tokens"]]) {
      await expect(menu.getByRole("link", { name })).toHaveAttribute("href", new RegExp(`^${path}\\?repo=[a-z0-9-]+$`));
    }
    await expect(menu.locator("portal-icon")).toHaveCount(5);
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
    // The board only shows once plan-suite is enabled; the hermetic machine has no packages.
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
    await page.goto("/plans");
    await page.getByText("Drawer fixture plan").first().click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer).toBeVisible();
    await expect(drawer.locator("#drawer-title")).toHaveText("Drawer fixture plan");
    await expect(drawer.locator("plan-status option-dropdown").first()).toBeVisible();
    await expect(drawer.locator("#drawer-meta")).not.toContainText("From worktree");
  });

  test("copy notifications appear above the plan document popup", async ({ page }, testInfo) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
    await page.goto("/plans");
    await page.getByText("Drawer fixture plan").first().click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer.locator("#drawer-cta")).toBeHidden();
    await drawer.getByRole("button", { name: "Plan actions", exact: true }).click();
    await drawer.getByRole("button", { name: /^Continue\b/ }).click();
    const toast = page.locator("#toast");
    await expect(toast).toContainText("Copied the /plan-execute prompt");
    // Visibility alone misses a toast painted underneath the modal backdrop.
    await expect.poll(() => toast.evaluate((node) => {
      const box = node.getBoundingClientRect();
      return node.contains(document.elementFromPoint(box.x + box.width / 2, box.y + box.height / 2));
    })).toBe(true);
    await expect(drawer).toBeVisible();
    const box = await toast.boundingBox();
    expect(box.x + box.width).toBeCloseTo(1260, 0);
    expect(box.y + box.height).toBeCloseTo(780, 0);
    await page.screenshot({ path: testInfo.outputPath("plan-copy-notification.png") });
    await page.keyboard.press("Escape");
    await expect(drawer).toBeHidden();
    await expect(toast).toBeVisible();
  });

  test("the drawer says when an active plan is read from its worktree", async ({ page }) => {
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
    await page.route("**/api/plans/document?*", async (route) => {
      const doc = await (await route.fetch()).json();
      doc.plan.plan.authority = { source: "worktree", worktree: "feature-x" };
      await route.fulfill({ json: doc });
    });
    await page.goto("/plans");
    await page.getByText("Drawer fixture plan").first().click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer.locator("#drawer-meta")).toContainText("From worktree feature-x");
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
    await expect(drawer.getByText(`${record.plan.priority} priority`, { exact: true })).toBeVisible();
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
    for (const lifecycle of ["backlog", "ready", "active", "review"]) fs.mkdirSync(path.join(planRoot, "docs", "plans", lifecycle), { recursive: true });
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "card-backlog.md"), plan("cardbk01", "Backlog card plan", "- [ ] Todo"));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "ready", "card-ready.md"), plan("cardrd01", "Ready card plan", "- [ ] Todo"));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "card-done.md"), plan("cardac01", "Finished card plan", "- [x] Done"));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "review", "card-findings.md"),
      plan("cardrv01", "Findings card plan", "- [x] Done\n\n## Review\n\n### Findings\n\n- [ ] Missing retry test"));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "review", "card-approved.md"),
      plan("cardrv02", "Approved card plan", "- [x] Done\n\n## Review\n\n### Approval\n\n- Decision: approved\n- Reviewed implementation commit: 0123456789abcdef0123456789abcdef01234567\n- Confirmed by: human"));
  });
  test.afterAll(() => fs.rmSync(planRoot, { recursive: true, force: true }));
  test.beforeEach(async ({ page }) => {
    await addRepositorySource(page, planRoot);
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      await route.fulfill({ json: data });
    });
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  // The portal copies suite commands; it never moves a plan on their behalf, since the suite
  // commands make and commit those moves themselves.
  for (const [tab, title, label, command, folder] of [
    ["Backlog", "Backlog card plan", "Promote", "plan-promote", "backlog/card-backlog.md"],
    ["Ready", "Ready card plan", "Start", "plan-execute", "ready/card-ready.md"],
    ["Active", "Finished card plan", "Review", "plan-review", "active/card-done.md"],
    ["Review", "Findings card plan", "Review", "plan-review", "review/card-findings.md"],
    ["Review", "Approved card plan", "Close", "plan-close", "review/card-approved.md"],
  ]) {
    test(`a ${tab.toLowerCase()} card's ${label} copies the /${command} prompt and moves nothing`, async ({ page }) => {
      await page.goto("/plans");
      await page.getByText(new RegExp(`^${tab} \\(`)).first().click();
      const card = page.locator("plan-card", { hasText: title });
      if (tab === "Active") {
        await expect(card.locator(".recommended-cta")).toHaveCount(0);
        await card.getByRole("button", { name: "Plan actions", exact: true }).click();
      } else {
        await expect(card.getByRole("button", { name: label, exact: true }).locator('portal-icon[name="copy"]')).toBeVisible();
      }
      const prompt = page.waitForRequest((request) => request.url().endsWith("/api/plans/prompt"));
      await card.getByRole("button", tab === "Active" ? { name: new RegExp(`^${label}\\b`) } : { name: label, exact: true }).click();
      expect((await prompt).postDataJSON().action).toBe(command);
      await expect(page.locator("#toast")).toContainText(`Copied the /${command} prompt`);
      expect(await page.evaluate(() => navigator.clipboard.readText())).toMatch(new RegExp(`^/${command}\\n`));
      if (tab === "Review") await expect(card.getByRole("button", { name: "Archive" })).toHaveCount(0);
      expect(fs.existsSync(path.join(planRoot, "docs", "plans", folder)), `${folder} stays where it was`).toBe(true);
      if (tab === "Backlog" || tab === "Ready") {
        await card.getByRole("button", { name: title, exact: false }).first().click();
        const drawer = page.getByRole("dialog").filter({ has: page.getByRole("heading", { name: title, exact: true }) });
        const drawerAction = drawer.getByRole("button", { name: label, exact: true });
        await expect(drawerAction).toBeVisible();
        await expect(drawerAction.locator('portal-icon[name="copy"]')).toBeVisible();
        const drawerPrompt = page.waitForRequest((request) => request.url().endsWith("/api/plans/prompt"));
        await drawerAction.click();
        expect((await drawerPrompt).postDataJSON().action).toBe(command);
      }
    });
  }

  test("plan cards separate document metadata from actions and work", async ({ page }, testInfo) => {
    await page.goto("/plans?lifecycle=review");
    const card = page.locator("plan-card", { hasText: "Findings card plan" });
    await expect(card).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("plans-layout.png") });
    const documentStatus = card.getByRole("group", { name: "Document status", exact: true });
    await expect(documentStatus.getByLabel(/^Modified /)).toContainText("now");
    await expect(documentStatus.getByRole("button", { name: "high", exact: true })).toBeVisible();
    const [detailsBox, priorityBox, modifiedBox, warningsBox] = await Promise.all([
      card.getByRole("button", { name: /Findings card plan/ }).first().boundingBox(),
      documentStatus.getByRole("button", { name: "high", exact: true }).boundingBox(),
      documentStatus.getByLabel(/^Modified /).boundingBox(),
      documentStatus.getByText(/^\d+ warnings$/).boundingBox(),
    ]);
    expect(priorityBox.x).toBeGreaterThanOrEqual(detailsBox.x + detailsBox.width);
    expect(modifiedBox.y).toBeGreaterThan(priorityBox.y);
    expect(warningsBox.y).toBeGreaterThan(modifiedBox.y);
    expect(Math.abs(priorityBox.x + priorityBox.width - modifiedBox.x - modifiedBox.width)).toBeLessThan(2);
    expect(Math.abs(warningsBox.x + warningsBox.width - modifiedBox.x - modifiedBox.width)).toBeLessThan(2);
    expect(await documentStatus.evaluate((node) => getComputedStyle(node).borderLeftWidth)).toBe("0px");
    const row = card.getByRole("group", { name: "Plan actions and work status", exact: true });
    const review = row.getByRole("button", { name: "Review", exact: true });
    const menu = row.getByRole("button", { name: "Plan actions", exact: true });
    const work = row.getByRole("group", { name: "Work status", exact: true });
    await expect(work).toContainText("1 open finding");
    const [actionBox, menuBox, workBox, metadataBox] = await Promise.all([review.boundingBox(), menu.boundingBox(), work.boundingBox(), documentStatus.boundingBox()]);
    expect(menuBox.x).toBeGreaterThan(actionBox.x + actionBox.width);
    expect(workBox.x).toBeGreaterThan(menuBox.x + menuBox.width);
    expect(Math.abs(actionBox.y + actionBox.height / 2 - workBox.y - workBox.height / 2)).toBeLessThan(2);
    expect(metadataBox.y + metadataBox.height).toBeLessThanOrEqual(actionBox.y);
    await expect(page.getByText("approved", { exact: true })).toHaveCount(0);
    await expect(page.getByText("awaiting review", { exact: true })).toHaveCount(0);
    await expect(page.getByText("valid", { exact: true })).toHaveCount(0);
    await expect(page.getByText("structure complete", { exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: /Findings card plan/ }).first().click();
    const drawer = page.locator("dialog#drawer");
    const drawerRow = drawer.getByRole("group", { name: "Plan actions and work status", exact: true });
    await expect(drawerRow.getByRole("button", { name: "Review", exact: true })).toBeVisible();
    await expect(drawerRow.getByRole("group", { name: "Work status", exact: true })).toContainText("1 open finding");
    const [drawerWorkBox, drawerActionBox, drawerMenuBox] = await Promise.all([
      drawerRow.getByRole("group", { name: "Work status", exact: true }).boundingBox(),
      drawerRow.getByRole("button", { name: "Review", exact: true }).boundingBox(),
      drawerRow.getByRole("button", { name: "Plan actions", exact: true }).boundingBox(),
    ]);
    expect(drawerWorkBox.x).toBeGreaterThan(drawerMenuBox.x + drawerMenuBox.width);
    expect(drawerMenuBox.x).toBeGreaterThan(drawerActionBox.x + drawerActionBox.width);
    const drawerDocument = drawer.getByRole("group", { name: "Document status", exact: true });
    await drawerDocument.getByRole("button", { name: "high", exact: true }).click();
    await drawerDocument.getByRole("option", { name: "low", exact: true }).click();
    await expect(drawerDocument.getByRole("button", { name: "low", exact: true })).toBeVisible();
    await expect(drawerRow.getByRole("button", { name: "Review", exact: true })).toBeVisible();
    const prompt = page.waitForRequest((request) => request.url().endsWith("/api/plans/prompt"));
    await drawerRow.getByRole("button", { name: "Review", exact: true }).click();
    expect((await prompt).postDataJSON().action).toBe("plan-review");
    await page.screenshot({ path: testInfo.outputPath("plan-popup-layout.png") });
    await drawer.getByRole("button", { name: "Close", exact: true }).click();
    await page.setViewportSize({ width: 390, height: 844 });
    await expect(review).toBeVisible();
    await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    const [narrowDetails, narrowMetadata] = await Promise.all([
      card.getByRole("button", { name: /Findings card plan/ }).first().boundingBox(),
      documentStatus.boundingBox(),
    ]);
    expect(narrowMetadata.y).toBeGreaterThanOrEqual(narrowDetails.y + narrowDetails.height);
    await page.screenshot({ path: testInfo.outputPath("plans-layout-narrow.png") });
  });

  test("hover highlights both document columns without highlighting the actions row", async ({ page }, testInfo) => {
    await page.goto("/plans?lifecycle=review");
    const card = page.locator("plan-card", { hasText: "Findings card plan" });
    const main = card.getByRole("button", { name: /Findings card plan/ }).first();
    const metadata = card.getByRole("group", { name: "Document status", exact: true });
    const actions = card.getByRole("group", { name: "Plan actions and work status", exact: true });
    const background = (node) => node.evaluate((element) => getComputedStyle(element).backgroundColor);
    const mainBefore = await background(main);
    const actionsBefore = await background(actions);
    await main.hover();
    expect(await background(main)).not.toBe(mainBefore);
    expect(await background(metadata)).toBe(await background(main));
    expect(await background(actions)).toBe(actionsBefore);
    await page.screenshot({ path: testInfo.outputPath("plan-hover.png") });
    await actions.getByRole("button", { name: "Review", exact: true }).hover();
    expect(await background(main)).toBe(mainBefore);
    expect(await background(metadata)).toBe(mainBefore);
  });

  test("copy menus show compact labels and separate the document filename", async ({ page }, testInfo) => {
    for (const lifecycle of ["backlog", "ready", "active", "review"]) {
      await page.goto(`/plans?lifecycle=${lifecycle}`);
      const card = page.locator("plan-card").first();
      await card.getByRole("button", { name: "Plan actions", exact: true }).click();
      const menu = card.getByRole("group", { name: "Copy options", exact: true });
      await expect(menu).toBeVisible();
      await expect(menu.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
      await expect(menu.getByRole("button", { name: "Portable prompt", exact: true })).toHaveCount(0);
      await expect(menu).not.toContainText("Copies a prompt");
      await expect(menu.locator('portal-icon[name="copy"]')).toHaveCount(await menu.getByRole("button").count());
      expect(await menu.locator(".plan-menu-group").evaluate((node) => getComputedStyle(node).rowGap)).toBe("0px");
      expect(await menu.evaluate((node) => getComputedStyle(node).rowGap)).toBe("0px");
      expect(await menu.locator(".plan-menu-filename").evaluate((node) => getComputedStyle(node).paddingTop)).toBe("0px");
      await expect(menu.locator(".menu-button-item-desc")).toHaveCount(0);
      const filename = menu.getByRole("button", { name: "Copy Document Filename", exact: true });
      await expect(filename).toBeVisible();
      expect(await filename.evaluate((node) => getComputedStyle(node.parentElement).borderTopWidth)).toBe("1px");
      expect(await filename.evaluate((node) => getComputedStyle(node).fontSize)).toBe("15px");
      if (lifecycle === "backlog") await page.screenshot({ path: testInfo.outputPath("copy-menu.png") });
      await filename.click();
      await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toMatch(/^[^/\\]+\.md$/);
      if (lifecycle === "backlog") {
        await card.getByRole("button", { name: "Plan actions", exact: true }).click();
        await card.getByRole("button", { name: /Backlog card plan/ }).first().click();
        const drawer = page.locator("dialog#drawer");
        await drawer.getByRole("button", { name: "Plan actions", exact: true }).click();
        const drawerMenu = drawer.getByRole("group", { name: "Copy options", exact: true });
        await expect(drawerMenu.getByRole("button", { name: "Copy Document Filename", exact: true })).toBeVisible();
        await expect(drawerMenu.getByRole("button", { name: "Update", exact: true })).toHaveCount(0);
        await expect(drawerMenu.locator('portal-icon[name="copy"]')).toHaveCount(await drawerMenu.getByRole("button").count());
      }
    }
  });

  test("modified age uses a clock and compact elapsed time while preserving the exact timestamp", async ({ page }) => {
    const now = new Date("2026-10-27T12:00:00Z");
    await page.clock.setFixedTime(now);
    const hour = 60 * 60 * 1000;
    const day = 24 * hour;
    let timestamp;
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      data.plans.find((record) => record.plan.title === "Findings card plan").plan.modifiedAt = timestamp;
      await route.fulfill({ json: data });
    });
    for (const [age, label] of [[0, "now"], [59 * 60 * 1000, "59 mins"], [hour, "1 hr"], [2 * hour, "2 hrs"], [day, "1 day"], [7 * day, "1 week"], [30 * day, "1 month"], [null, "unknown"]]) {
      timestamp = age === null ? "not a timestamp" : new Date(now.getTime() - age).toISOString();
      await page.goto("/plans?lifecycle=review");
      const modified = page.locator("plan-card", { hasText: "Findings card plan" }).getByLabel(/^Modified /);
      await expect(modified).toHaveText(label);
      await expect(modified.locator('portal-icon[name="clock"]')).toBeVisible();
      if (age === null) {
        await expect(modified).toHaveAttribute("title", "Modified time unknown");
        await expect(modified).not.toHaveAttribute("datetime");
      } else {
        await expect(modified).toHaveAttribute("datetime", timestamp);
        await expect(modified).toHaveAttribute("title", /^Modified /);
      }
    }
  });

  test("a structurally complete backlog card shows Promote without positive document badges", async ({ page }) => {
    await page.route("**/api/plans", async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      const record = data.plans.find((record) => record.plan.title === "Backlog card plan");
      record.plan.validation.warnings = [];
      record.plan.readiness = "ready";
      await route.fulfill({ json: data });
    });
    await page.goto("/plans?lifecycle=backlog");
    const card = page.locator("plan-card", { hasText: "Backlog card plan" });
    await expect(card.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await expect(card.getByRole("group", { name: "Document status", exact: true }).getByLabel(/^Modified /)).toContainText("now");
    await expect(card).not.toContainText("structure complete");
    await expect(card).not.toContainText("valid");
    await expect(card).not.toContainText("warning");
  });

  test("lifecycle tabs keep Completed, Archived and Unclassified behind the ⋮ menu", async ({ page }) => {
    await page.goto("/plans");
    const bar = page.locator("#lifecycle-bar");
    const title = page.locator("#lifecycle-title");
    const row = page.locator("#lifecycle-tabs");
    await expect(title).toHaveText("Active Plans");
    const barBox = await bar.boundingBox();
    const rowBox = await row.boundingBox();
    expect(rowBox.x).toBeGreaterThan(barBox.x, "the title is a left column opposite the tabs");
    // Filters is the right-most element, just after the tabs and their ⋮ menu; Refresh sits beside the title.
    const filtersBox = await page.locator("#filters-toggle").boundingBox();
    const refreshBox = await page.locator("#refresh").boundingBox();
    const titleBox = await title.boundingBox();
    expect(Math.abs(filtersBox.x + filtersBox.width - barBox.x - barBox.width)).toBeLessThanOrEqual(1);
    expect(rowBox.x + rowBox.width).toBeLessThanOrEqual(filtersBox.x + 1);
    expect(refreshBox.x).toBeGreaterThanOrEqual(titleBox.x + titleBox.width);
    expect(refreshBox.x + refreshBox.width).toBeLessThan(rowBox.x);
    await expect(row.locator(":scope > .lifecycle-tab")).toHaveText([/^Backlog \(/, /^Ready \(/, /^Active \(/, /^Review \(/]);
    const trigger = row.locator(".overflow-more-trigger");
    await expect(trigger).toHaveAttribute("aria-label", "More lifecycles");
    await expect(trigger).not.toHaveClass(/\bactive\b/);
    await trigger.click();
    await row.locator("#lifecycle-tabs-more-panel .lifecycle-tab:visible", { hasText: /^Completed \(/ }).click();
    await expect(page).toHaveURL(/lifecycle=completed/);
    await expect(title).toHaveText("Completed Plans");
    await expect(trigger).not.toHaveClass(/\bactive\b/);
    await trigger.click();
    await row.locator("#lifecycle-tabs-more-panel .lifecycle-tab:visible", { hasText: /^Archived \(/ }).click();
    await expect(page).toHaveURL(/lifecycle=archived/);
    await expect(title).toHaveText("Archived Plans");
    await expect(row.locator("#lifecycle-tabs-more-panel")).toBeHidden();
    await expect(trigger).not.toHaveClass(/\bactive\b/);
    await expect(page.getByRole("button", { name: "View All Open Tasks" })).toHaveCount(0);
    await expect(page.locator("#all-tasks-modal")).toHaveCount(0);
  });

  test("a narrow viewport collapses the lifecycle tabs into a menu named for the selection", async ({ page }) => {
    await page.setViewportSize({ width: 420, height: 780 });
    await page.goto("/plans?lifecycle=backlog");
    const bar = page.locator("#lifecycle-bar");
    await expect(page.locator("#lifecycle-title")).toBeHidden();
    const row = page.locator("#lifecycle-tabs");
    await expect(row.locator(":scope > .lifecycle-tab:visible")).toHaveCount(0);
    const trigger = row.locator(".overflow-more-trigger");
    await expect(trigger).toHaveText("Backlog Plans");
    await expect(trigger).not.toHaveAttribute("aria-label");
    await row.locator(".overflow-more-current").click();
    const items = row.locator("#lifecycle-tabs-more-panel .lifecycle-tab:visible");
    // Unclassified joins only when a registered repository has such a plan, so match the fixed six.
    await expect(items.first()).toBeVisible();
    expect((await items.allTextContents()).slice(0, 6).map((text) => text.replace(/ \(.*/, ""))).toEqual(
      ["Backlog", "Ready", "Active", "Review", "Completed", "Archived"],
    );
    const barBox = await bar.boundingBox();
    const triggerBox = await trigger.boundingBox();
    expect(Math.abs(triggerBox.x - barBox.x),
      "the collapsed trigger is left-aligned").toBeLessThanOrEqual(1);
    // Narrow: Filters at the right edge, Refresh directly to its right.
    const filtersBox = await page.locator("#filters-toggle").boundingBox();
    const refreshBox = await page.locator("#refresh").boundingBox();
    expect(Math.abs(refreshBox.x + refreshBox.width - barBox.x - barBox.width)).toBeLessThanOrEqual(8);
    expect(refreshBox.x).toBeGreaterThanOrEqual(filtersBox.x + filtersBox.width);
    await items.filter({ hasText: /^Active \(/ }).click();
    await expect(page).toHaveURL(/lifecycle=active/);
    await expect(trigger).toHaveText("Active Plans");
  });
});

test.describe("Plans onboarding", () => {
  const SUITE = ["plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive", "session-close"];
  const SUITE_PACKAGES = ["plan-suite", "session-close"];

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

  test("the enable button turns on the plan-suite and session-close packages in one request", async ({ page }) => {
    await page.goto("/plans");
    const token = await page.locator("meta[name=cli-portal-token]").getAttribute("content");
    const bulk = page.waitForRequest((request) => request.url().endsWith("/api/config/packages/bulk") && request.method() === "POST");
    await page.locator(".package-onboarding").getByRole("button", { name: "Enable the Plan Suite" }).click();
    expect((await bulk).postDataJSON()).toEqual({ ids: SUITE_PACKAGES, enabled: true });
    await expect(page.locator(".package-onboarding")).toBeHidden();
    const config = await (await page.request.get("/api/config")).json();
    const section = config.behaviorView.find((item) => item.categoryId === "skills-dev-lifecycle");
    for (const id of SUITE_PACKAGES) {
      expect(section.items.find((item) => item.id === id)?.active, `${id} enabled`).toBe(true);
    }
    // Leave the hermetic machine as the other specs expect it: no suite packages enabled.
    const reset = await page.request.post("/api/config/packages/bulk", {
      headers: { "X-Cli-Portal-Token": token },
      data: { ids: SUITE_PACKAGES, enabled: false },
    });
    expect(reset.ok()).toBe(true);
  });
});

// No built-in category carries a Select All switch, but the portal still renders one for any
// section marked bulkToggle. Serves the live config with the first package section so marked, and
// returns that config so a routed bulk response can hand it back unchanged.
async function routeBulkToggleConfig(page) {
  const config = await (await page.request.get("/api/config")).json();
  const section = config.behaviorView.find((entry) => entry.categoryId && entry.items.some((item) => item.toggle));
  section.bulkToggle = true;
  await page.route("**/api/config", (route) => route.fulfill({ json: config }));
  return config;
}

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

test("Home fixture retries a reset read before applying its repository patch", async ({ page }) => {
  let reads = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/api/home") {
      reads += 1;
      if (reads === 1) return request.socket.destroy();
      response.setHeader("Content-Type", "application/json");
      return response.end(JSON.stringify({ repositories: [{ displayName: "RoboRepo", marker: "original" }] }));
    }
    response.setHeader("Content-Type", "text/html");
    response.end(`<script>fetch('/api/home').then(r => r.json()).then(d => { document.body.textContent = d.repositories[0].marker; });</script><body></body>`);
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  try {
    await patchRoboRepo(page, (repository) => { repository.marker = "patched after reset"; });
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await expect(page.getByText("patched after reset", { exact: true })).toBeVisible();
    expect(reads).toBe(2);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Serves the real /api/home response with the RoboRepo repository adjusted by `mutate`, so each test
// states only the domain data it depends on.
async function patchRoboRepo(page, mutate) {
  await page.route("**/api/home", async (route) => {
    // Retry a transient connection reset on this read only; HTTP failures still reach the test.
    const data = await (await route.fetch({ maxRetries: 2 })).json();
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
        { id: "a", key: "a", title: "Plan A", worktree: "feature-a", relativePath: "docs/plans/active/plan-a.md", checkoutRootId: "matched", taskCounts: { total: 4, complete: 2 } },
        { id: "b", key: "b", title: "Plan B", worktree: "feature-b", relativePath: "docs/plans/active/plan-b.md", checkoutRootId: "no-app", taskCounts: { total: 3, complete: 3 } },
        { id: "c", key: "c", title: "Plan C", worktree: "", taskCounts: { total: 0, complete: 0 } },
        { id: "d", key: "d", title: "Plan D", worktree: "gone", worktreeState: "missing", taskCounts: { total: 2, complete: 0 } },
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
