// The Plans card's status strip and the shared completion it carries: a progress ring, the `done`
// badge once every task is checked, and beside either the `merged` badge once the plan's worktree
// has landed — the same join Home draws from its overview. The card keeps lifecycle, review state, and the next
// action out of the strip; the next action stays in the plan drawer.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import {
  addRepositorySource,
  enablePlanBoard,
  patchHomeOverview,
  planRowOf,
  removeRepositorySources,
  roboRepoCard,
} from "./helpers.mjs";

const plan = ({ id, title, nextAction, tasks, frontmatter = [] }) => [
  "---", `id: ${id}`, "priority: high", `next_action: ${nextAction}`, ...frontmatter, "---", "",
  `# ${title}`, "", "## Summary", "", "Body.", "", "## Tasks", "", ...tasks, "",
].join("\n");

// One Home overview repository whose only active plan is matched to a worktree Runtime reports as
// merged into main.
function landedWorktree(planRecord) {
  return {
    plans: { status: "available", data: { counts: { active: 1, backlog: 0 }, active: [{
      id: planRecord.plan.id, key: planRecord.key, title: planRecord.plan.title, lifecycle: "active", worktree: "merged-tree",
      checkoutRootId: "merged-tree", taskCounts: { total: 3, complete: 1 },
    }] } },
    runtime: { status: "available", data: { checkouts: [
      { rootId: "merged-tree", name: "feature/merged", isWorktree: true, worktreeName: "merged-tree", worktreeState: "landed", mergedInto: "main", git: { branch: "feature/merged", provider: { ok: true } } },
    ] } },
  };
}

async function planRecord(page, title) {
  const plans = await (await page.request.get("/api/plans")).json();
  return plans.plans.find((item) => item.plan.title === title);
}

test.describe("Plans card status", () => {
  let planRoot;
  test.beforeAll(() => {
    planRoot = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-status-"));
    fs.mkdirSync(path.join(planRoot, ".git"));
    for (const lifecycle of ["backlog", "active", "review", "completed"]) fs.mkdirSync(path.join(planRoot, "docs", "plans", lifecycle), { recursive: true });
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "review", "status-review.md"),
      plan({ id: "streview", title: "Review status plan", nextAction: "Fix the finding", tasks: ["- [x] One", "", "## Review", "", "### Findings", "", "- [ ] Missing retry test"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "status-ring.md"),
      plan({ id: "string01", title: "Ring status plan", nextAction: "Ship the ring step", tasks: ["- [x] One", "- [ ] Two"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "status-merged.md"),
      plan({ id: "stmerg01", title: "Merged status plan", nextAction: "Close it out", tasks: ["- [x] One", "- [ ] Two", "- [ ] Three"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-done.md"),
      plan({ id: "stdone01", title: "Done status plan", nextAction: "Nothing left", tasks: ["- [x] One", "- [x] Two"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-blocker.md"),
      plan({ id: "stblkr01", title: "Blocker target plan", nextAction: "Land the prerequisite", tasks: ["- [ ] One"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "completed", "status-completed.md"),
      plan({ id: "stcmp001", title: "Completed dependency plan", nextAction: "Done", tasks: ["- [x] One"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-satisfied.md"),
      plan({ id: "stsat001", title: "Satisfied dependency plan", nextAction: "Promote", tasks: ["- [ ] One"],
        frontmatter: ['depends_on: [stcmp001]'] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-dependent.md"),
      plan({ id: "stdep001", title: "Dependent status plan", nextAction: "Wait", tasks: ["- [ ] One"],
        frontmatter: ['depends_on: [stblkr01, stcmp001, string01, missing1]'] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-blocked.md"),
      plan({ id: "stblkd01", title: "Blocked status plan", nextAction: "Wait for the prerequisite", tasks: ["- [ ] One"],
        frontmatter: ['blocked_by: [stblkr01, "upstream: vendor API is not ready"]'] }));
  });
  test.afterAll(() => fs.rmSync(planRoot, { recursive: true, force: true }));
  test.beforeEach(async ({ page }) => {
    await addRepositorySource(page, planRoot);
    await enablePlanBoard(page);
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  test("an in-progress card shows the completion ring and leaves lifecycle, review, and next action off the card", async ({ page }) => {
    await page.goto("/plans?lifecycle=active");
    const card = page.locator("plan-card", { hasText: "Ring status plan" });
    const ring = card.getByRole("progressbar", { name: "Ring status plan completion" });
    await expect(ring).toHaveAttribute("aria-valuenow", "50");
    await expect(card.locator(".plan-percent")).toHaveText("50%");
    // Priority is the strip's only control: lifecycle moves belong to the plan suite's commands.
    await expect(card.locator("plan-status option-dropdown")).toHaveCount(1);
    await expect(card).not.toContainText("never-reviewed");
    await expect(card).not.toContainText("Ship the ring step");
    await expect(card).not.toContainText("Next up");
  });

  // Implementation progress and QA outcome are separate claims: the task list says the work is built,
  // and only the review record says whether it passed.
  test("a review card shows its open findings apart from its task progress", async ({ page }) => {
    await page.goto("/plans?lifecycle=review");
    const card = page.locator("plan-card", { hasText: "Review status plan" });
    await expect(card.locator(".chip", { hasText: "1 open finding" })).toBeVisible();
    await expect(card.getByRole("button", { name: "Review", exact: true })).toBeVisible();
    await expect(card).not.toContainText("approved");
  });

  test("a finished task list shows the done badge in place of the ring", async ({ page }) => {
    await page.goto("/plans?lifecycle=backlog");
    const card = page.locator("plan-card", { hasText: "Done status plan" });
    await expect(card.locator(".plan-complete-badge")).toHaveText("done");
    await expect(card.getByRole("progressbar")).toHaveCount(0);
  });

  test("a plan whose worktree has merged shows the merged badge beside its progress on its card and in its drawer", async ({ page }) => {
    const record = await planRecord(page, "Merged status plan");
    await patchHomeOverview(page, (overview) => {
      overview.repositories.push({ displayName: "Merged fixture", domains: landedWorktree(record) });
    });
    await page.goto("/plans?lifecycle=active");
    const card = page.locator("plan-card", { hasText: "Merged status plan" });
    const badge = card.locator(".plan-merged-badge");
    await expect(badge).toHaveText("merged");
    await expect(badge).toHaveAttribute("title", "Merged into main");
    await expect(card.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "33");
    await expect(card.locator(".plan-percent")).toHaveText("33%");

    await card.getByText("Merged status plan").click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer.locator("plan-status .plan-merged-badge")).toHaveText("merged");
    await expect(drawer.locator("plan-status .plan-percent")).toHaveText("33%");
  });

  // A blocker id that names a plan in the same repository is a link to that plan; an external
  // blocker names no plan, so it has nothing to open and stays plain text.
  test("the blocked-by badge lists each blocker, and a known blocker opens its plan", async ({ page }, testInfo) => {
    await page.goto("/plans?lifecycle=backlog");
    const card = page.locator("plan-card", { hasText: "Blocked status plan" });
    const blocked = card.getByRole("button", { name: "blocked by 2" });
    const warning = card.getByRole("group", { name: "Document status", exact: true }).getByText(/^\d+ warnings?$/);
    expect(await blocked.evaluate((node) => getComputedStyle(node).fontSize)).toBe(await warning.evaluate((node) => getComputedStyle(node).fontSize));
    await card.screenshot({ path: testInfo.outputPath("blocked-badge.png") });
    await blocked.click();
    const popover = page.locator("#blockers-popover");
    await expect(popover).toBeVisible();
    await expect(popover.locator(".blockers-popover-title")).toHaveText("Blocked by 2");
    await expect(popover.getByText("upstream: vendor API is not ready")).toBeVisible();
    await expect(popover.getByRole("button", { name: "upstream: vendor API is not ready" })).toHaveCount(0);

    await popover.getByRole("button", { name: "Blocker target plan" }).click();
    await expect(popover).toBeHidden();
    await expect(page.locator("dialog#drawer #drawer-title")).toHaveText("Blocker target plan");
  });

  test("backlog dependencies replace Promote with linked IDs on cards and in the drawer", async ({ page }, testInfo) => {
    await page.goto("/plans?lifecycle=backlog");
    const card = page.locator("plan-card", { hasText: "Dependent status plan" });
    await expect(card).toContainText("depends on stblkr01, string01, missing1");
    await expect(card).not.toContainText("stcmp001");
    const menuBox = await card.getByRole("button", { name: "Plan actions", exact: true }).boundingBox();
    const dependencyBox = await card.getByRole("button", { name: "stblkr01", exact: true }).boundingBox();
    expect(menuBox.x + menuBox.width).toBeLessThan(dependencyBox.x);
    await expect(card.getByRole("button", { name: "Promote", exact: true })).toHaveCount(0);
    await expect(card.getByRole("button", { name: "missing1", exact: true })).toHaveCount(0);
    await card.getByRole("button", { name: "Plan actions", exact: true }).click();
    await expect(card.getByRole("group", { name: "Copy options" }).getByRole("button", { name: "Promote", exact: true })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("dependencies.png") });
    await card.getByRole("button", { name: "Plan actions", exact: true }).click();
    await card.getByRole("button", { name: "stblkr01", exact: true }).click();
    await expect(page.locator("#drawer-title")).toHaveText("Blocker target plan");
    await page.locator("#drawer-close").click();
    await card.getByRole("button", { name: "string01", exact: true }).click();
    await expect(page.locator("#drawer-title")).toHaveText("Ring status plan");
    await page.locator("#drawer-close").click();
    await card.getByText("Dependent status plan", { exact: true }).click();
    const drawer = page.getByRole("dialog");
    const drawerMenuBox = await drawer.getByRole("button", { name: "Plan actions", exact: true }).boundingBox();
    const drawerDependencyBox = await drawer.getByRole("button", { name: "stblkr01", exact: true }).boundingBox();
    expect(drawerMenuBox.x + drawerMenuBox.width).toBeLessThan(drawerDependencyBox.x);
    await expect(drawer.getByRole("button", { name: "Promote", exact: true })).toHaveCount(0);
    await drawer.getByRole("button", { name: "Plan actions", exact: true }).click();
    await expect(drawer.getByRole("button", { name: "Promote", exact: true })).toHaveCount(0);
  });

  test("completed dependencies restore Promote on the card and in its popup", async ({ page }) => {
    await page.goto("/plans?lifecycle=backlog");
    const card = page.locator("plan-card", { hasText: "Satisfied dependency plan" });
    await expect(card).not.toContainText("depends on");
    await expect(card.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Plan actions", exact: true }).click();
    await expect(card.getByRole("group", { name: "Copy options" }).getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await card.getByRole("button", { name: "Plan actions", exact: true }).click();
    await card.getByText("Satisfied dependency plan", { exact: true }).click();
    const drawer = page.locator("#drawer");
    await expect(drawer.locator("#drawer-dependencies")).toBeHidden();
    await expect(drawer.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await drawer.getByRole("button", { name: "Plan actions", exact: true }).click();
    await expect(drawer.getByRole("group", { name: "Copy options" }).getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    const snapshot = await (await page.request.get("/api/plans")).json();
    expect(snapshot.plans.find((record) => record.plan.id === "stsat001").plan.dependencies).toEqual(["stcmp001"]);
  });

  test("copying the drawer path shows a green check without adding confirmation text", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await page.goto("/plans?lifecycle=backlog");
    await page.locator("plan-card", { hasText: "Dependent status plan" }).getByText("Dependent status plan", { exact: true }).click();
    const copy = page.locator("#drawer-path-copy");
    await copy.getByRole("button", { name: "Copy path", exact: true }).click();
    await expect(copy.getByRole("button", { name: "Copied", exact: true })).toBeVisible();
    await expect(copy.locator('portal-icon[name="check"]')).toBeVisible();
    await expect(copy).toHaveText("");
    await expect.poll(() => page.evaluate(() => navigator.clipboard.readText())).toBe("docs/plans/backlog/status-dependent.md");
  });

  test("the drawer keeps the lifecycle and next action the card leaves out", async ({ page }) => {
    await page.goto("/plans?lifecycle=active");
    await page.locator("plan-card", { hasText: "Ring status plan" }).getByText("Ring status plan").click();
    const meta = page.locator("dialog#drawer #drawer-meta");
    await expect(meta).toContainText("lifecycle");
    await expect(meta).toContainText("Active");
    await expect(meta).toContainText("next action");
    await expect(meta).toContainText("Ship the ring step");
  });

  test("Home's read-only drawer shows the merged badge for a plan whose worktree has merged", async ({ page }) => {
    const record = await planRecord(page, "Merged status plan");
    await patchHomeOverview(page, (overview) => {
      const repository = overview.repositories.find((item) => item.displayName === "RoboRepo");
      Object.assign(repository.domains, landedWorktree(record));
    });
    await page.goto("/");
    await planRowOf(roboRepoCard(page), "Merged status plan").getByRole("button", { name: "Merged status plan", exact: true }).click();
    const drawer = page.locator("dialog#drawer");
    await expect(drawer.locator("plan-status .plan-merged-badge")).toHaveText("merged");
  });
});
