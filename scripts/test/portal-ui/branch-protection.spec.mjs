// Branch protection in the portal: the Plans page's one-time notice and when it returns, the
// status panel a Home repo card's menu opens, and the admin-only actions in it. The portal server
// reads GitHub through the fake `gh` that run.mjs puts on its PATH; each test sets that fake's state.
import { test, expect } from "@playwright/test";
import { fakeGhControls, fakeGitHubState } from "../lib/fake-gh.mjs";
import { createPlanFixture } from "../lib/plan-git-fixture.mjs";
import { addRepositorySource, enablePlanBoard, removeFixtureContents, removeRepositorySources, roboRepoCard } from "./helpers.mjs";

const fakeEnv = { FAKE_GH_STATE: process.env.FAKE_GH_STATE, FAKE_GH_LOG: process.env.FAKE_GH_LOG };
const REPO = "example/protection-suite";
const planFile = ["---", "id: prot0001", "next_action: Start", "---", "", "# Protection fixture plan", "", "## Summary", "", "Body.", "", "## Tasks", "", "- [ ] One", ""].join("\n");

test.describe("Branch protection", () => {
  test.skip(!fakeEnv.FAKE_GH_STATE, "the fake gh executable requires a POSIX runner");
  const gh = fakeGhControls(fakeEnv);
  const start = (overrides) => {
    gh.setState(fakeGitHubState(overrides));
    gh.clearCalls();
  };
  const writes = () => gh.calls().filter((call) => call.method !== "GET");
  let fx;
  let planRoot;

  test.beforeAll(() => {
    fx = createPlanFixture("portal-ui-protection-");
    planRoot = fx.repository("protection-suite", { "plans/active/protection-plan.md": planFile });
    // The checkout's recorded origin names a GitHub repo, which is what the portal reads its
    // identity from; Git itself still talks to the fixture's local bare origin.
    const bare = fx.git(planRoot, "remote", "get-url", "origin");
    fx.git(planRoot, "config", `url.${bare}.insteadOf`, `git@github.com:${REPO}.git`);
    fx.git(planRoot, "remote", "set-url", "origin", `git@github.com:${REPO}.git`);
  });
  test.afterAll(() => {
    gh.setState(fakeGitHubState({ failure: "unreachable" }));
    removeFixtureContents(fx);
  });
  test.beforeEach(async ({ page }) => {
    await addRepositorySource(page, planRoot);
    await enablePlanBoard(page);
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  const notices = (page) => page.getByRole("region", { name: "Branch protection" });
  const panel = (page) => page.getByRole("dialog", { name: "Branch protection" });
  const openPlans = async (page) => {
    await page.goto("/plans?lifecycle=active");
    await expect(page.locator("plan-card", { hasText: "Protection fixture plan" })).toBeVisible();
  };
  const openPanelFromHome = async (page) => {
    await page.goto("/");
    const card = roboRepoCard(page);
    await card.getByRole("button", { name: "Actions", exact: true }).click();
    await card.getByRole("button", { name: "Branch protection" }).click();
    await expect(panel(page)).toBeVisible();
  };

  test("the notice shows once for an unprotected repo and stays away on reload", async ({ page }) => {
    start();
    await openPlans(page);
    const line = notices(page).locator(".protection-notice");
    await expect(line).toHaveCount(1);
    await expect(line).toContainText(`${REPO} is not fully protected on GitHub: plan history can be deleted or rewritten; the default branch can be deleted or force-pushed; changes can reach the default branch without review or passing CI.`);
    await expect(line.getByRole("button", { name: "Protect" })).toBeVisible();

    const read = page.waitForResponse((response) => response.url().includes("/protection") && response.request().method() === "GET");
    await page.reload();
    await read;
    await expect(page.locator("plan-card", { hasText: "Protection fixture plan" })).toBeVisible();
    await expect(notices(page)).toBeHidden();
    expect(writes()).toEqual([]);
  });

  test("the notice returns with Protect when the account becomes an admin", async ({ page }) => {
    start({ admin: false, login: "octo-reader" });
    await openPlans(page);
    const line = notices(page).locator(".protection-notice");
    await expect(line).toContainText("Signed in to GitHub as octo-reader, who is not an admin of this repo; a repo admin must run roborepo protect.");
    await expect(line.getByRole("button", { name: "Protect" })).toBeHidden();

    start({ admin: true });
    await page.reload();
    await expect(line).toHaveCount(1);
    await expect(line.getByRole("button", { name: "Protect" })).toBeVisible();
  });

  test("Protect clears the notice and the panel reads protected", async ({ page }) => {
    start();
    await openPlans(page);
    await notices(page).getByRole("button", { name: "Protect" }).click();
    await expect(panel(page)).toBeVisible();
    await expect(panel(page).locator("[data-slot=state]")).toHaveText("protected");
    await expect(panel(page)).toContainText("roborepo-plans (repo-plans): matches the policy");
    await expect(panel(page)).toContainText("Required CI checks: check (macos-latest), check (ubuntu-latest)");
    await expect(notices(page)).toBeHidden();
    expect(writes().map((call) => [call.method, call.body.name])).toEqual([
      ["POST", "roborepo-plans"], ["POST", "roborepo-main-integrity"], ["POST", "roborepo-main-merge"],
    ]);
  });

  test("the Branch protection menu item opens the panel in every state", async ({ page }) => {
    const conflicting = { id: 31, name: "everything-needs-review", target: "branch", source_type: "Repository", source: REPO, enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~ALL"], exclude: [] } }, rules: [{ type: "required_signatures" }] };
    const handMade = { id: 11, name: "protect-main", target: "branch", source_type: "Repository", source: REPO, enforcement: "active", bypass_actors: [], conditions: { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } }, rules: [{ type: "deletion" }, { type: "non_fast_forward" }] };

    start();
    await openPanelFromHome(page);
    const dialog = panel(page);
    const state = dialog.locator("[data-slot=state]");
    await expect(state).toHaveText("missing");
    await expect(dialog).toContainText("roborepo-plans (repo-plans): not created; missing deletion, non_fast_forward, required_linear_history");
    await dialog.getByRole("button", { name: "Protect" }).click();
    await expect(state).toHaveText("protected");
    const managed = gh.readState().rulesets;
    await dialog.getByRole("button", { name: "Close" }).click();

    const reopen = async (overrides) => {
      start(overrides);
      await openPanelFromHome(page);
    };
    await reopen({ rulesets: [...managed, handMade] });
    await expect(state).toHaveText("protected");
    await expect(dialog).toContainText("protect-main: covered by the managed rulesets; safe to delete");

    const drifted = structuredClone(managed);
    drifted.find((ruleset) => ruleset.name === "roborepo-plans").rules.pop();
    await reopen({ rulesets: drifted });
    await expect(state).toHaveText("drifted");
    await expect(dialog).toContainText("roborepo-plans (repo-plans): differs from the policy: rule required_linear_history is missing");

    await reopen({ rulesets: managed.map((ruleset) => ({ ...ruleset, id: ruleset.id - 8000, name: ruleset.name.replace("roborepo-", "hand-") })) });
    await expect(state).toHaveText("unmanaged");
    await expect(dialog.getByRole("button", { name: "Protect" })).toBeVisible();

    await reopen({ rulesets: [...managed, conflicting] });
    await expect(state).toHaveText("conflicting");
    await expect(dialog).toContainText("Rule required_signatures from ruleset everything-needs-review reaches the repo-plans branch and will refuse plan saves.");
    await expect(dialog.getByRole("button", { name: "Protect" })).toBeHidden();

    await reopen({ failure: "not-signed-in" });
    await expect(state).toHaveText("unavailable");
    await expect(dialog).toContainText("the GitHub CLI is not signed in (run: gh auth login)");

    await reopen({ failure: "rulesets-refused" });
    await expect(state).toHaveText("unsupported");
    await expect(dialog).toContainText("GitHub does not offer rulesets for this repo");
    await expect(dialog).toContainText("On the repo-plans branch: block deletion, block force pushes, and require linear history.");
    await expect(dialog.getByRole("button", { name: "Protect" })).toBeHidden();
  });

  test("Skip merge rules asks first, and Use merge rules restores protection", async ({ page }) => {
    start();
    await openPanelFromHome(page);
    const dialog = panel(page);
    const state = dialog.locator("[data-slot=state]");
    await dialog.getByRole("button", { name: "Protect" }).click();
    await expect(state).toHaveText("protected");
    gh.clearCalls();

    await dialog.getByRole("button", { name: "Skip merge rules" }).click();
    const confirm = dialog.getByRole("alertdialog", { name: "Skip merge rules" });
    await expect(confirm).toContainText("This turns off the required approval and the required CI checks on the default branch");
    await expect(confirm).toContainText("The plans and integrity rules stay on.");
    expect(writes()).toEqual([]);
    await confirm.getByRole("button", { name: "Keep merge rules" }).click();
    await expect(confirm).toBeHidden();
    expect(writes()).toEqual([]);

    await dialog.getByRole("button", { name: "Skip merge rules" }).click();
    await confirm.getByRole("button", { name: "Turn off merge rules" }).click();
    await expect(state).toHaveText("protected, merge rules skipped");
    await expect(dialog).toContainText("roborepo-main-merge (main): skipped (turned off for this repo)");
    expect(writes().map((call) => [call.method, call.body.name, call.body.enforcement])).toEqual([["PUT", "roborepo-main-merge", "disabled"]]);

    await dialog.getByRole("button", { name: "Use merge rules" }).click();
    await expect(state).toHaveText("protected");
    await expect(dialog).toContainText("roborepo-main-merge (main): matches the policy");
    await expect(dialog.getByRole("button", { name: "Skip merge rules" })).toBeVisible();
  });

  test("a non-admin sees the state and the command, and no action buttons", async ({ page }) => {
    start({ admin: false, login: "octo-reader" });
    await openPanelFromHome(page);
    const dialog = panel(page);
    await expect(dialog.locator("[data-slot=state]")).toHaveText("missing");
    await expect(dialog).toContainText("Signed in to GitHub as octo-reader, who is not an admin of this repo. A repo admin must run: roborepo protect");
    for (const name of ["Protect", "Skip merge rules", "Use merge rules"]) {
      await expect(dialog.getByRole("button", { name })).toBeHidden();
    }

    const skipped = fakeGitHubState({ admin: false, login: "octo-reader" });
    start({ admin: true });
    await page.request.post(`/api/repositories/${encodeURIComponent("git:github.com/example/roborepo")}/protection`, {
      headers: { "X-Cli-Portal-Token": await page.locator("meta[name=cli-portal-token]").getAttribute("content") },
      data: { action: "protect" },
    });
    const rulesets = gh.readState().rulesets;
    rulesets.find((ruleset) => ruleset.name === "roborepo-main-merge").enforcement = "disabled";
    start({ ...skipped, rulesets });
    await openPanelFromHome(page);
    await expect(dialog.locator("[data-slot=state]")).toHaveText("protected, merge rules skipped");
    await expect(dialog).toContainText("A repo admin can turn the merge rules back on with: roborepo protect --unskip main-merge");
    await expect(dialog.getByRole("button", { name: "Use merge rules" })).toBeHidden();
    expect(writes()).toEqual([]);
  });
});
