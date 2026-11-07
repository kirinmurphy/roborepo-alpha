// The Import Plan dialog against a real plans store: preview, Backlog creation, diff confirmation for
// an existing plan, refusals shown in place, and a push that reaches the bare origin.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { createPlanFixture, planDoc } from "../lib/plan-git-fixture.mjs";
import { addRepositorySource, enablePlanBoard, removeRepositorySources } from "./helpers.mjs";

test.describe("Import Plan", () => {
  test.describe.configure({ mode: "serial" });
  let fx;
  let root;
  let store;
  let uploads;

  const upload = (name, content) => {
    const file = path.join(uploads, name);
    fs.writeFileSync(file, content);
    return file;
  };
  const remoteFile = (relative) => fx.git(root, "show", `origin/repo-plans:${relative}`);

  test.beforeAll(() => {
    uploads = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-import-"));
    fx = createPlanFixture("portal-ui-import-store-");
    root = fx.repository("import-fixture", {
      "plans/plans-config.json": JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "Alpha work." } }),
      "plans/backlog/alpha-existing.md": planDoc({ id: "alphaex1", title: "Existing import plan" }),
    });
    store = fx.storePath(root);
  });

  test.beforeEach(async ({ page }) => {
    await page.goto("/");
    await removeRepositorySources(page);
    await addRepositorySource(page, root);
    await enablePlanBoard(page);
  });

  // The page's own reload after a save can still be in flight when a test's assertions finish.
  test.afterEach(({ page }) => page.unrouteAll({ behavior: "ignoreErrors" }));

  test.afterAll(async () => {
    fx.cleanup();
    fs.rmSync(uploads, { recursive: true, force: true });
  });

  test("the + button sits right of Filters and opens the modal", async ({ page }) => {
    await page.goto("/plans");
    const toggle = page.getByRole("button", { name: "Import Plan" });
    await expect(toggle).toBeVisible();
    const filters = await page.locator("#filters-toggle").boundingBox();
    const box = await toggle.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(filters.x + filters.width);
    await toggle.click();
    await expect(page.getByRole("dialog", { name: "Import Plan" })).toBeVisible();
    await expect(page.locator("#plan-import-dialog")).not.toContainText("repository");
  });

  test("a new plan previews, lands in Backlog, and reaches the remote", async ({ page }) => {
    await page.goto("/plans");
    await page.getByRole("button", { name: "Import Plan" }).click();
    const dialog = page.locator("#plan-import-dialog");
    await dialog.locator("input[type=file]").setInputFiles(upload("alpha-fresh-import.md", planDoc({ id: "alphanw1", title: "Brand new import" })));
    await expect(dialog.locator("[data-slot=title]")).toHaveText("Brand new import");
    await expect(dialog.locator("[data-slot=id]")).toHaveText("alphanw1");
    await expect(dialog.locator("[data-slot=filename]")).toHaveText("alpha-fresh-import.md");
    await expect(dialog.locator("[data-slot=folder]")).toHaveText("backlog");
    expect(fs.existsSync(path.join(store, "plans/backlog/alpha-fresh-import.md")), "a preview writes nothing").toBe(false);
    await dialog.getByRole("button", { name: "Add to Backlog" }).click();
    await expect(dialog.locator("[data-slot=status]")).toContainText("pushed it to the remote");
    expect(remoteFile("plans/backlog/alpha-fresh-import.md")).toContain("Brand new import");
  });

  test("an existing plan shows its diff and changes only after confirmation", async ({ page }) => {
    await page.goto("/plans");
    await page.getByRole("button", { name: "Import Plan" }).click();
    const dialog = page.locator("#plan-import-dialog");
    const edited = planDoc({ id: "alphaex1", title: "Existing import plan" }).replace("# Existing import plan", "# Existing import plan\n\nAn uploaded line.");
    await dialog.locator("input[type=file]").setInputFiles(upload("anything.md", edited));
    await expect(dialog.locator("[data-slot=diff]")).toContainText("+An uploaded line.");
    expect(fs.readFileSync(path.join(store, "plans/backlog/alpha-existing.md"), "utf8")).not.toContain("An uploaded line.");
    await dialog.getByRole("button", { name: "Update Plan" }).click();
    await expect(dialog.locator("[data-slot=status]")).toContainText("plans/backlog/alpha-existing.md");
    expect(remoteFile("plans/backlog/alpha-existing.md")).toContain("An uploaded line.");
  });

  test("a refused file explains itself in the dialog and offers no save", async ({ page }) => {
    await page.goto("/plans");
    await page.getByRole("button", { name: "Import Plan" }).click();
    const dialog = page.locator("#plan-import-dialog");
    await dialog.locator("input[type=file]").setInputFiles(upload("alpha-approved.md", `${planDoc({ id: "alphaap1", title: "Approved import" })}\n## Review\n\n### Approval\n- Decision: approved\n`));
    await expect(dialog.locator("[data-slot=error]")).toContainText("Approval");
    await expect(dialog.getByRole("button", { name: "Add to Backlog" })).toBeDisabled();
  });
});

test.describe("A repo with no plans store", () => {
  let bare;
  test.beforeAll(() => {
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-not-set-up-"));
    fs.mkdirSync(path.join(bare, ".git"));
  });
  test.afterAll(() => fs.rmSync(bare, { recursive: true, force: true }));

  test("Plans names /plan-suite-init instead of reporting zero plans", async ({ page }) => {
    await page.goto("/");
    await removeRepositorySources(page);
    await addRepositorySource(page, bare);
    await enablePlanBoard(page);
    await page.route(/\/api\/plans(\?|$)/, async (route) => {
      const data = await (await route.fetch()).json();
      data.planSuitePackage = { ...data.planSuitePackage, available: true, enabled: true };
      data.plans = [];
      data.repositoryScans = [{ repositoryId: "only", name: "Unset repo", state: "not-set-up", planCount: 0, checkoutCount: 1 }];
      await route.fulfill({ json: data });
    });
    await page.goto("/plans");
    await expect(page.locator("#plans-onboarding")).toContainText("/plan-suite-init");
    await expect(page.locator("#plans-onboarding")).not.toContainText("No plans");
  });
});
