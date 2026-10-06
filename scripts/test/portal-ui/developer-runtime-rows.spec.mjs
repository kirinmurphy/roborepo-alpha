// Runtime page checkout rows (docs/plans/completed/developer-runtime-repository-row-layout.md).
//
// Drives the REAL portal server run.mjs boots, but never its discovery: the snapshot is stubbed in
// the browser so the page renders the same repositories on every machine. The stub body is built by
// buildDeveloperRuntimeSnapshot from a synthetic discovery input, so roles and the promoted link come
// from the real builder rather than a hand-written copy of the snapshot shape.
//
// Two stub rules matter:
//   - route.fulfill without route.fetch(): passing the request through would run real discovery
//     against whatever is listening on this host.
//   - /refresh is stubbed too. A fixture opaque key always 404s on /metadata, which triggers a forced
//     refresh; unstubbed, that refresh would swap the fixture for real discovery mid-test.

import { test, expect } from "@playwright/test";
import { buildDeveloperRuntimeSnapshot, defaultSettings } from "../../../modules/developer-runtime/index.mjs";

const DEMO = "git:github.com/example/demo";
const SHOP = "git:github.com/example/shop";
const IDLE = "git:github.com/example/idle";
const WORKTREE_BRANCH = "codex/telemetry-tokens-conditions-and-waste-report";
const mainGit = { provider: { ok: true }, branch: "main", isWorktree: false, ahead: 0, behind: 0 };
const worktreeGit = { provider: { ok: true }, branch: WORKTREE_BRANCH, isWorktree: true, ahead: 0, behind: 0 };

function listener({ pid, port, command = "node", title = null, rootId, git, projectRoot, repositoryId = DEMO, status = 200, docker = null, identity = repositoryId, health = null, confidence = "high" }) {
  return {
    key: `${pid}:127.0.0.1:${port}`,
    associationKey: `a${pid}`,
    matchSignature: { key: `a${pid}`, titleKey: `t${pid}`, relativeCwd: ".", command, title },
    origin: `http://127.0.0.1:${port}`,
    alternateOrigins: [],
    bind: { address: "127.0.0.1", port, scope: "loopback", warning: null },
    status,
    latencyMs: 1,
    protocol: "http",
    tls: null,
    title,
    contentType: title ? "text/html" : null,
    health,
    docker,
    processMetrics: { cpuPercent: 0.1, cpuPercentOfHost: 0.1, residentMemoryKb: 1000 },
    process: { pid, command },
    project: { identity, identityKind: identity.startsWith("process:") ? "process" : "git", confidence, projectRoot, evidence: "Git remote", repositoryId, rootId, git },
  };
}

const snapshot = JSON.parse(JSON.stringify(buildDeveloperRuntimeSnapshot({
  discovery: {
    capabilities: { discovery: "supported" },
    warnings: [],
    composeProjectGit: new Map([["shop", {
      git: mainGit,
      repositoryId: SHOP,
      resolvedFrom: "auto",
      rootId: "shop-main",
      ownership: "owned",
      ownershipEvidence: { kind: "bind-mount", checkoutPaths: ["/tmp/shop"] },
    }]]),
    instances: [
      // Main checkout: the app plus Storybook, which must not take the promoted slot.
      listener({ pid: 10, port: 4317, title: "Demo", rootId: "demo-main", git: mainGit, projectRoot: "/tmp/demo" }),
      listener({ pid: 11, port: 6006, title: "Storybook", rootId: "demo-main", git: mainGit, projectRoot: "/tmp/demo" }),
      // The worktree's only member is its promoted app, so the row folds it in. Unhealthy, so the
      // folded row has something to say.
      listener({ pid: 12, port: 56183, title: "Demo", rootId: "demo-wt", git: worktreeGit, projectRoot: `/tmp/worktrees/${WORKTREE_BRANCH.split("/").pop()}`, health: { state: "unhealthy" } }),
      // A listener no repository claims: its cwd resolved to no git checkout.
      listener({ pid: 30, port: 9911, title: "Stray", repositoryId: null, identity: "process:/tmp:stray", projectRoot: null, confidence: "low" }),
      // A Compose-only checkout whose `web` service is the app.
      listener({
        pid: 20,
        port: 8080,
        title: "Shop",
        repositoryId: null,
        identity: "process:/tmp/c:20",
        projectRoot: null,
        command: "com.docker.backend",
        docker: { containerId: "shop-web", name: "shop-web-1", composeService: "web", composeProject: "shop", image: "node", state: "running" },
      }),
    ],
  },
  settings: defaultSettings(),
  now: new Date("2026-09-29T00:00:00.000Z"),
  // An idle repository whose one checkout runs nothing.
  persistedRepositories: [{
    repositoryId: IDLE,
    name: "idle",
    lifecycle: { state: "idle", reason: null },
    lastSeenAt: "2026-09-20T00:00:00.000Z",
    checkouts: [{ rootId: "idle-main", kind: "primary", state: "present", reason: null, projectRoot: "/tmp/idle", git: mainGit }],
  }],
})));

test.beforeEach(async ({ page }) => {
  await page.route("**/api/developer-runtime", (route) => route.fulfill({ json: snapshot }));
  await page.route("**/api/developer-runtime/refresh", (route) => route.fulfill({ json: snapshot }));
  await page.goto("/runtime");
});

const card = (page, name) => page.locator(".repository-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
const row = (page, rootId) => page.locator(`.repository-root[data-root-id="${rootId}"]`);

test.describe("Runtime checkout rows (developer-runtime-repository-row-layout)", () => {
  test("the main checkout row links its app, not its tooling, and the card header links nothing", async ({ page }) => {
    const main = row(page, "demo-main");
    await expect(main.getByRole("link", { name: ":4317", exact: true })).toBeVisible();
    await expect(main.getByRole("link", { name: ":6006", exact: true })).toHaveCount(0);
    await expect(card(page, "demo").locator(".card-head").getByRole("link", { name: /:\d+$/ })).toHaveCount(0);
  });

  test("only the member toggle opens the member list", async ({ page }) => {
    const main = row(page, "demo-main");
    const toggle = main.getByRole("button", { name: "Show 2 members" });
    await expect(toggle).toBeVisible();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await main.getByText("main branch", { exact: true }).click();
    await expect(main.locator("[data-slot=members]")).toBeHidden();
    await toggle.click();
    await expect(main.locator("[data-slot=members]")).toBeVisible();
    await expect(main.getByRole("button", { name: "Hide 2 members" })).toHaveAttribute("aria-expanded", "true");
  });

  test("a checkout with no members shows no toggle and no idle text", async ({ page }) => {
    const idle = row(page, "idle-main");
    await expect(idle).toBeVisible();
    await expect(idle.getByRole("button", { name: /members?$/ })).toHaveCount(0);
    await expect(idle.getByText(/Inactive|no active members|checkout missing/)).toHaveCount(0);
  });

  test("a long branch label is truncated, and hovering it opens a tooltip led by the full name", async ({ page }) => {
    const label = row(page, "demo-wt").getByText(/^codex\/.*report$/);
    await expect(label).not.toHaveText(WORKTREE_BRANCH);
    await expect(label).toHaveText(/…/);
    await label.hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip).toBeVisible();
    await expect(tooltip.locator(".info-tooltip-heading")).toHaveText(WORKTREE_BRANCH);
    await expect(tooltip).toHaveText(new RegExp(`^\\s*${WORKTREE_BRANCH}`));
  });

  test("a worktree row keeps its copy control beside the branch label", async ({ page }) => {
    const worktree = row(page, "demo-wt");
    await expect(worktree.locator("[data-slot=root-info]")).toBeVisible();
    await expect(worktree.locator("[data-slot=root-copy]").getByRole("button")).toHaveCount(1);
  });

  test("a Compose-only checkout promotes its web service", async ({ page }) => {
    await expect(row(page, "shop-main").getByRole("link", { name: ":8080", exact: true })).toBeVisible();
  });

  test("a checkout whose only member is its promoted app folds that member into the row", async ({ page }) => {
    const worktree = row(page, "demo-wt");
    const head = worktree.locator(".repository-root-head");
    await expect(worktree.getByRole("button", { name: /members?$/ })).toHaveCount(0);
    await expect(head.getByRole("button", { name: "Actions", exact: true })).toBeVisible();
    await expect(head.getByText("unhealthy", { exact: true })).toBeVisible();
    await worktree.getByText(/^codex\/.*report$/).hover();
    const tooltip = page.getByRole("tooltip");
    await expect(tooltip.getByText("App", { exact: true })).toBeVisible();
    await expect(tooltip.getByText("Process", { exact: true })).toBeVisible();
  });

  test("the member toggle says what it opens", async ({ page }) => {
    await expect(row(page, "shop-main").getByRole("button", { name: "Show 1 container", exact: true })).toBeVisible();
  });

  test("an unrecognized listener offers only the actions that still apply to it", async ({ page }) => {
    await page.locator("details.collapsed-group > summary").click();
    const stray = page.locator(".collapsed-group .instance-card")
      .filter({ has: page.getByRole("link", { name: ":9911", exact: true }) });
    await expect(stray.getByRole("button", { name: "Links", exact: true })).toHaveCount(0);
    await stray.getByRole("button", { name: "Actions", exact: true }).click();
    const menu = stray.locator("[data-menu]");
    await expect(menu.getByRole("button")).toHaveText(["Copy PID", "View history", "Hide from Runtime"]);
  });

  // The Links scenarios assert the buttons and never open them: opening fetches /metadata with a
  // fixture key, which 404s by design.
  test("the promoted member's Links dropdown moves into the checkout row", async ({ page }) => {
    const main = row(page, "demo-main");
    await expect(main.locator(".repository-root-head").getByRole("button", { name: "Links", exact: true })).toBeVisible();
    await expect(main.getByRole("button", { name: "Links", exact: true }).locator("portal-icon[name=link] svg")).toBeVisible();
    await main.getByRole("button", { name: "Show 2 members" }).click();
    const memberCard = (port) => main.locator("[data-slot=members] .instance-card")
      .filter({ has: page.getByRole("link", { name: `:${port}`, exact: true }) });
    await expect(memberCard(4317).getByRole("button", { name: "Links", exact: true })).toHaveCount(0);
    await expect(memberCard(6006).getByRole("button", { name: "Links", exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "Pages/Routes" })).toHaveCount(0);
  });

  test("a checkout promoting a Compose container also gets a Links button", async ({ page }) => {
    await expect(row(page, "shop-main").locator(".repository-root-head").getByRole("button", { name: "Links", exact: true })).toBeVisible();
  });
});
