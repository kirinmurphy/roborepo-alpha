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

const plan = ({ id, title, nextAction, tasks }) => [
  "---", `id: ${id}`, "priority: high", `next_action: ${nextAction}`, "---", "",
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
    for (const lifecycle of ["backlog", "active"]) fs.mkdirSync(path.join(planRoot, "docs", "plans", lifecycle), { recursive: true });
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "status-ring.md"),
      plan({ id: "string01", title: "Ring status plan", nextAction: "Ship the ring step", tasks: ["- [x] One", "- [ ] Two"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "active", "status-merged.md"),
      plan({ id: "stmerg01", title: "Merged status plan", nextAction: "Close it out", tasks: ["- [x] One", "- [ ] Two", "- [ ] Three"] }));
    fs.writeFileSync(path.join(planRoot, "docs", "plans", "backlog", "status-done.md"),
      plan({ id: "stdone01", title: "Done status plan", nextAction: "Nothing left", tasks: ["- [x] One", "- [x] Two"] }));
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
