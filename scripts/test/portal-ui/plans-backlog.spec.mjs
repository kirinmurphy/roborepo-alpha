// Backlog as a user drives it: repositories, then namespaces, then one list shown as Details or
// Ordering, with order edits held in a draft until Save. The fixture repo has a two-plan chain, an
// independent ranked plan, and an unprioritized plan in `alpha`, a plan in `beta`, and one file whose
// prefix is not approved.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addRepositorySource, enablePlanBoard, removeRepositorySources } from "./helpers.mjs";

const document = ({ id, title, deps = [] }) => [
  "---", `id: ${id}`, "next_action: Do it", `depends_on: [${deps.join(", ")}]`, "---", "",
  `# ${title}`, "", "## Summary", "", `Purpose of ${title}.`, "",
].join("\n");

const GUARD = "Your prioritization changes have not been saved.";

test.describe("Backlog directory and ordering", () => {
  let repo;
  let bare;
  let repoName;
  let bareName;
  let orderFile;
  const write = (relative, content) => {
    const file = path.join(repo, relative);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
  };
  const savedOrder = () => JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.alpha;
  const setOrder = (ids) => fs.writeFileSync(orderFile, `${JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ids } }, null, 2)}\n`);

  test.beforeAll(() => {
    // Each build gets names of its own: a failed test restarts the worker and rebuilds this fixture,
    // and a removed source's repository stays registered under its name.
    repo = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-backlog-"));
    bare = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-bare-"));
    repoName = path.basename(repo);
    bareName = path.basename(bare);
    fs.mkdirSync(path.join(repo, ".git"), { recursive: true });
    fs.mkdirSync(path.join(bare, ".git"), { recursive: true });
    orderFile = path.join(repo, "docs/plans/plans-order.json");
    write("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A", beta: "B" } }));
    write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage" }));
    write("docs/plans/backlog/alpha-retrieval.md", document({ id: "alphab02", title: "Retrieval", deps: ["alphaa01"] }));
    write("docs/plans/backlog/alpha-diagnostics.md", document({ id: "alphax03", title: "Diagnostics" }));
    write("docs/plans/backlog/alpha-traces.md", document({ id: "alphan04", title: "Traces" }));
    write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one" }));
    write("docs/plans/backlog/wrong-prefix.md", document({ id: "wrong006", title: "Misfiled plan" }));
    write("docs/plans/active/alpha-working.md", document({ id: "alphaw07", title: "Working plan" }));
    fs.mkdirSync(path.join(bare, "docs/plans/backlog"), { recursive: true });
    fs.writeFileSync(path.join(bare, "docs/plans/backlog/anything.md"), document({ id: "barepl08", title: "Unconfigured plan" }));
  });

  test.afterAll(() => {
    for (const root of [repo, bare]) fs.rmSync(root, { recursive: true, force: true });
  });

  test.beforeEach(async ({ page }) => {
    setOrder(["alphaa01", "alphab02", "alphax03"]);
    await addRepositorySource(page, repo);
    await addRepositorySource(page, bare);
    await enablePlanBoard(page);
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  async function repoKey(page, name) {
    const { backlog } = await (await page.request.get("/api/plans")).json();
    return backlog.find((entry) => entry.name === name).urlKey;
  }
  async function openNamespace(page, namespace = "alpha", name = repoName) {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, name)}&namespace=${namespace}`);
  }
  async function openOrdering(page) {
    await openNamespace(page);
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await expect(page.locator("backlog-block").first()).toBeVisible();
  }
  const orderedList = (page) => page.getByRole("group", { name: "Ordered plans" });
  const orderedTitles = (page) => orderedList(page).getByRole("button", { name: /^ALPHA · / });
  const directoryRows = (page) => page.getByRole("group", { name: "Backlog directory" }).getByRole("link");
  const blockFor = (page, title) => page.locator("backlog-block", { has: page.getByRole("button", { name: title, exact: true }) });
  const guardDialog = (page) => page.getByRole("dialog", { name: GUARD });

  test("repositories lead to namespaces, with No namespace last and counts of plans", async ({ page }) => {
    await page.goto("/plans?lifecycle=backlog");
    const repoRow = page.getByRole("link", { name: new RegExp(repoName) });
    await expect(repoRow).toContainText("6 plans");
    await expect(repoRow).toContainText("2 unprioritized");
    await expect(page.locator("plan-card")).toHaveCount(0);
    await repoRow.click();

    const rows = directoryRows(page);
    await expect(rows.nth(0)).toContainText("ALPHA");
    await expect(rows.nth(0)).toContainText("4 plans");
    await expect(rows.nth(0)).toContainText("1 unprioritized");
    await expect(rows.nth(1)).toContainText("BETA");
    await expect(rows.nth(2)).toContainText("No namespace");
    await expect(rows.nth(2)).toContainText("Repair needed");

    await rows.nth(0).click();
    await expect(page).toHaveURL(/namespace=alpha/);
    await page.reload();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.goBack();
    await expect(rows.nth(2)).toContainText("No namespace");
  });

  test("filters narrow the directory counts", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Retrieval");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    const rows = directoryRows(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first()).toContainText("1 plan");
  });

  test("filters narrow Details, and Ordering shows the whole namespace regardless", async ({ page }) => {
    await openNamespace(page);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Retrieval");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page.locator(".title-link")).toHaveText(["ALPHA · Retrieval"]);
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Storage", "ALPHA · Retrieval", "ALPHA · Diagnostics"]);
    await expect(page.getByRole("button", { name: "ALPHA · Traces", exact: true })).toBeVisible();
    await expect(page.locator("filter-chip")).toHaveCount(0);
  });

  test("Details shows flat cards with a namespace prefix, Needs prioritization first", async ({ page }) => {
    await openNamespace(page);
    const headings = page.getByRole("heading", { name: /^(Needs prioritization|Ordered)/ });
    await expect(headings.nth(0)).toHaveText("Needs prioritization (1)");
    await expect(headings.nth(1)).toHaveText("Ordered");
    await expect(page.locator(".title-link")).toHaveText(["ALPHA · Traces", "ALPHA · Storage", "ALPHA · Retrieval", "ALPHA · Diagnostics"]);
    await expect(page.locator("backlog-block")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
    await expect(page.getByText("linked plans")).toHaveCount(0);
  });

  test("Ordering draws linked plans as one block with exact controls and hides Filters", async ({ page }) => {
    await openOrdering(page);
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeHidden();
    const group = blockFor(page, "ALPHA · Storage");
    await expect(group).toContainText("2 linked plans");
    await expect(group).toContainText("ALPHA · Retrieval");
    await expect(group).toContainText("Requires: Storage");
    const names = (locator) => locator.locator("[aria-label]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    const ranked = ["Move to top", "Move up", "Move down", "Move to bottom", "Drag to move"];
    await expect.poll(() => names(group.getByRole("group", { name: "Move" }))).toEqual(ranked);
    await expect(group.getByRole("group", { name: "Move" })).toHaveCount(1);
    await expect.poll(() => names(blockFor(page, "ALPHA · Diagnostics").getByRole("group", { name: "Move" }))).toEqual(ranked);
    await expect.poll(() => names(blockFor(page, "ALPHA · Traces").getByRole("group", { name: "Move" }))).toEqual(["Move down", "Move to bottom", "Drag to move"]);
    await expect(group.getByRole("button", { name: "Move up" })).toBeDisabled();
    await expect(blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to bottom" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test("moves stay in the draft until Save, and focus follows the moved block", async ({ page }) => {
    await openOrdering(page);
    const before = fs.readFileSync(orderFile, "utf8");
    await blockFor(page, "ALPHA · Traces").getByRole("button", { name: "Move down" }).click();
    await expect(page.getByRole("heading", { name: /^Needs prioritization/ })).toHaveCount(0);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move up" }).focus();
    await page.keyboard.press("Enter");
    await expect(blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move up" })).toBeFocused();
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Traces", "ALPHA · Diagnostics", "ALPHA · Storage", "ALPHA · Retrieval"]);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphan04", "alphax03", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.locator(".title-link")).toHaveText(["ALPHA · Traces", "ALPHA · Diagnostics", "ALPHA · Storage", "ALPHA · Retrieval"]);
    await expect(page.getByRole("dialog", { name: GUARD })).toHaveCount(0);
  });

  test("Cancel discards after confirming", async ({ page }) => {
    await openOrdering(page);
    const before = fs.readFileSync(orderFile, "utf8");
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Keep editing" }).click();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Storage");
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);
  });

  test("dragging a block moves it among the blocks, as a draft", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("img", { name: "Drag to move" }).dragTo(blockFor(page, "ALPHA · Storage"), { targetPosition: { x: 40, y: 2 } });
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Diagnostics", "ALPHA · Storage", "ALPHA · Retrieval"]);
    await blockFor(page, "ALPHA · Traces").getByRole("img", { name: "Drag to move" }).dragTo(blockFor(page, "ALPHA · Diagnostics"), { targetPosition: { x: 40, y: 2 } });
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Traces");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);
  });

  test("leaving a dirty draft asks first: Cancel stays, Save and continue saves and goes", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    const makeDirtyAgain = async () => {
      await page.getByRole("button", { name: "Ordering", exact: true }).click();
      await blockFor(page, "ALPHA · Traces").getByRole("button", { name: "Move to bottom" }).click();
    };

    // Details toggle.
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(guardDialog(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);

    // Lifecycle tab.
    await makeDirtyAgain();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/lifecycle=backlog/);

    // Breadcrumb.
    await page.getByRole("navigation", { name: "Backlog location" }).getByRole("link", { name: "All repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/namespace=alpha/);

    // Header link to another portal page.
    await page.getByRole("navigation", { name: "Portal sections" }).getByRole("link", { name: "Repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/\/plans/);

    // Lifecycle tab again, this time saving: the save happens, then the move.
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(page).toHaveURL(/lifecycle=active/);
    await expect(page).not.toHaveURL(/namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02", "alphan04"]);
  });

  test("back/forward cannot be cancelled, so a dirty draft restores the URL and asks", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    await directoryRows(page).first().click();
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.goBack();
    await expect(guardDialog(page)).toBeVisible();
    await expect(page).toHaveURL(/namespace=alpha/);
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
    await page.goBack();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(page).not.toHaveURL(/namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("the repo selector holds its change while a draft is dirty", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    const selector = page.locator("#repository-scope option-dropdown");
    await selector.getByRole("button").first().click();
    await page.getByRole("option", { name: "All repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
    await expect(page).toHaveURL(/namespace=alpha/);
    await expect(selector).toContainText(repoName);
  });

  test("closing the tab with a dirty draft raises the browser's own prompt", async ({ page }) => {
    const tab = await page.context().newPage();
    await enablePlanBoard(tab);
    await openOrdering(tab);
    await blockFor(tab, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    const prompted = new Promise((resolve) => {
      tab.once("dialog", async (dialog) => {
        resolve(dialog.type());
        await dialog.accept();
      });
    });
    await tab.close({ runBeforeUnload: true });
    expect(await prompted).toBe("beforeunload");
  });

  test("a change elsewhere makes a dirty draft stale: nothing is overwritten", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    setOrder(["alphax03", "alphan04", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Diagnostics", "ALPHA · Traces", "ALPHA · Storage", "ALPHA · Retrieval"]);
  });

  test("a save the server refuses keeps the draft and says why", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    setOrder(["alphax03", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
  });

  test("an automatic regrouping shows a notice and leaves the file alone on read", async ({ page }) => {
    setOrder(["alphaa01", "alphax03", "alphab02"]);
    const before = fs.readFileSync(orderFile, "utf8");
    await openOrdering(page);
    await expect(page.getByText("Moved to stay with linked plans: Retrieval.")).toBeVisible();
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Storage", "ALPHA · Retrieval", "ALPHA · Diagnostics"]);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test.describe("config edits", () => {
    let config;
    let original;
    const writeNamespaces = (namespaces) => fs.writeFileSync(config, JSON.stringify({ schemaVersion: 1, namespaces }));
    test.beforeEach(() => {
      config = path.join(repo, "docs/plans/plans-config.json");
      original = fs.readFileSync(config, "utf8");
    });
    test.afterEach(() => fs.writeFileSync(config, original));

    test("adding, removing, and renaming a namespace reach an open directory at Refresh", async ({ page }) => {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      const row = (text) => directoryRows(page).filter({ hasText: text });
      await expect(row("No namespace")).toContainText("1 plan");

      writeNamespaces({ alpha: "A", beta: "B", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("WRONG")).toContainText("1 plan");
      await expect(row("No namespace")).toHaveCount(0);

      writeNamespaces({ alpha: "A", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("BETA")).toHaveCount(0);
      await expect(row("No namespace")).toContainText("1 plan");

      writeNamespaces({ alpha: "A", gamma: "was beta", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("GAMMA")).toHaveCount(0);
      await expect(row("No namespace")).toContainText("1 plan");
    });

    test("an unreadable config is an error, and no plan disappears", async ({ page }) => {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      fs.writeFileSync(config, "{ nope");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByText("docs/plans/plans-config.json cannot be read")).toBeVisible();
      await expect(directoryRows(page)).toHaveCount(1);
      await expect(directoryRows(page)).toContainText("6 plans");
    });

    test("a dirty draft cannot save across a conflicting config edit", async ({ page }) => {
      await openOrdering(page);
      await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
      writeNamespaces({ alpha: "A", beta: "B", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("a dirty draft survives its namespace being removed, stale and still guarded", async ({ page }) => {
      await openOrdering(page);
      await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
      const held = fs.readFileSync(orderFile, "utf8");
      writeNamespaces({ beta: "B" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
      await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
      await page.getByRole("button", { name: /^Active \(/ }).click();
      await expect(guardDialog(page)).toBeVisible();
      await expect(guardDialog(page).getByRole("button", { name: "Save and continue" })).toBeDisabled();
      await guardDialog(page).getByRole("button", { name: "Cancel" }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await page.getByRole("button", { name: "Discard changes" }).click();
      await expect(directoryRows(page).filter({ hasText: "No namespace" })).toBeVisible();
      expect(fs.readFileSync(orderFile, "utf8")).toBe(held);
    });
  });

  test("the Save bar stays on screen while a long list scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(blockFor(page, "ALPHA · Retrieval")).not.toBeInViewport();
    const bar = page.getByRole("group", { name: "Unsaved order" });
    await expect(bar).toBeInViewport({ ratio: 1 });
    await blockFor(page, "ALPHA · Retrieval").scrollIntoViewIfNeeded();
    await expect(bar).toBeInViewport({ ratio: 1 });
  });

  test("a double click on Save sends one save and leaves the page working", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    let saves = 0;
    page.on("request", (request) => { if (request.url().endsWith("/api/plans/order")) saves += 1; });
    await page.getByRole("button", { name: "Save", exact: true }).dblclick();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    expect(saves).toBe(1);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.locator(".title-link").first()).toBeVisible();
    expect(errors).toEqual([]);
  });

  test("Needs prioritization counts plans, not blocks, in both modes", async ({ page }) => {
    setOrder([]);
    await openNamespace(page);
    const heading = page.getByRole("heading", { name: /^Needs prioritization/ });
    await expect(heading).toHaveText("Needs prioritization (4)");
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await expect(page.locator("backlog-block")).toHaveCount(3);
    await expect(heading).toHaveText("Needs prioritization (4)");
  });

  test("a plan with a duplicate id is shown with its reason and no controls", async ({ page }) => {
    const copies = ["docs/plans/backlog/alpha-twin-one.md", "docs/plans/backlog/alpha-twin-two.md"];
    try {
      for (const [index, file] of copies.entries()) write(file, document({ id: "twinplan", title: `Twin ${index}` }));
      await openOrdering(page);
      await expect(page.getByText("Duplicate id: twinplan")).toHaveCount(2);
      await expect(page.locator("backlog-block", { hasText: "Twin" })).toHaveCount(0);
    } finally {
      for (const file of copies) fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("an unparseable order file locks Ordering and says why, and is left alone", async ({ page }) => {
    fs.writeFileSync(orderFile, "{ nope");
    await openOrdering(page);
    await expect(page.getByText("docs/plans/plans-order.json cannot be read")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to bottom" })).toHaveCount(0);
    await expect(page.locator("backlog-block").first()).toContainText("blocked");
    expect(fs.readFileSync(orderFile, "utf8")).toBe("{ nope");
  });

  // Delays the snapshot refresh a Save or Discard ends with. Falls back so the plan board stays enabled.
  async function holdRefresh(page) {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route(/\/api\/plans\/refresh/, async (route) => {
      await held;
      await route.fallback();
    });
    return release;
  }

  test("after a Save lands, the saved order holds its controls until the new snapshot arrives", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openOrdering(page);
    const release = await holdRefresh(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    await expect(orderedTitles(page)).toHaveText(["ALPHA · Diagnostics", "ALPHA · Storage", "ALPHA · Retrieval"]);
    const moveDown = blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move down" });
    await expect(moveDown).toBeDisabled();
    await expect(blockFor(page, "ALPHA · Diagnostics").getByRole("img", { name: "Drag to move" })).toHaveAttribute("draggable", "false");
    release();
    await expect(moveDown).toBeEnabled();
    await moveDown.click();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeEnabled();
    expect(errors).toEqual([]);
  });

  test("after a Discard, the committed order is live before the refresh returns", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openOrdering(page);
    const release = await holdRefresh(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await page.getByRole("button", { name: "Discard changes" }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Storage");
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
    release();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(orderedTitles(page).first()).toHaveText("ALPHA · Diagnostics");
    expect(errors).toEqual([]);
  });

  test("a re-render during a Save keeps both buttons held", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/plans/order", async (route) => {
      await held;
      await route.continue();
    });
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    const refreshed = page.waitForResponse(/\/api\/plans\/refresh/);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await refreshed;
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    release();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("a failed Save through the guard stays put and says why", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    setOrder(["alphax03", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(guardDialog(page).getByRole("alert")).toContainText("changed since you opened Ordering");
    await expect(guardDialog(page).getByRole("button", { name: "Save and continue" })).toBeDisabled();
    await expect(page).toHaveURL(/lifecycle=backlog.*namespace=alpha/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("Save and continue from the repo selector saves, then changes the repo", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.locator("#repository-scope option-dropdown").getByRole("button").first().click();
    await page.getByRole("option", { name: "All repos" }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(page).not.toHaveURL(/repo=|namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    await expect(page.getByRole("link", { name: new RegExp(repoName) })).toBeVisible();
  });

  test("a breadcrumb leaves a dirty draft in place, keeping filters and the page", async ({ page }) => {
    await openNamespace(page);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Retrieval");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.getByRole("button", { name: "Ordering", exact: true }).click();
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.evaluate(() => { window.samePage = true; });
    await page.getByRole("navigation", { name: "Backlog location" }).getByRole("link", { name: repoName }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(page).not.toHaveURL(/namespace=/);
    await expect(page.locator("filter-chip")).toHaveCount(1);
    expect(await page.evaluate(() => window.samePage)).toBe(true);
  });

  test("while a Save is in flight, neither Cancel can take it back", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/plans/order", async (route) => {
      await held;
      await route.continue();
    });
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await expect(guardDialog(page)).toBeHidden();
    release();
    await expect(page).toHaveURL(/lifecycle=active/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("the guard's Cancel waits for its Save, which then decides the move", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/plans/order", async (route) => {
      await held;
      await route.continue();
    });
    await openOrdering(page);
    await blockFor(page, "ALPHA · Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and continue" }).click();
    await expect(guardDialog(page).getByRole("button", { name: "Cancel" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(guardDialog(page)).toBeVisible();
    release();
    await expect(page).toHaveURL(/lifecycle=active/);
  });

  test("a cancelled drag does not leave its block armed", async ({ page }) => {
    await openOrdering(page);
    const before = await orderedTitles(page).allTextContents();
    await blockFor(page, "ALPHA · Diagnostics").getByRole("img", { name: "Drag to move" }).dispatchEvent("dragstart", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    await blockFor(page, "ALPHA · Diagnostics").getByRole("img", { name: "Drag to move" }).dispatchEvent("dragend");
    await orderedList(page).dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()), clientY: 0 });
    await expect(orderedTitles(page)).toHaveText(before);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test("No namespace lists the exact filename and how to repair it, with no ordering", async ({ page }) => {
    await openNamespace(page, "_none");
    await expect(page.getByText("wrong-prefix.md")).toBeVisible();
    await expect(page.getByText("Unknown plan namespace: wrong.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy Repair Prompt" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Ordering", exact: true })).toHaveCount(0);
  });

  test("a repo with no config shows one No namespace row and a notice, no per-file findings", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, bareName)}`);
    await expect(page.getByText("/plan-suite-init")).toBeVisible();
    const row = directoryRows(page);
    await expect(row).toHaveCount(1);
    await expect(row).toContainText("No namespace");
    await expect(row).not.toContainText("Repair needed");
    await row.click();
    await expect(page.locator("plan-card", { hasText: "Unconfigured plan" })).toBeVisible();
    await expect(page.getByRole("button", { name: "Copy Repair Prompt" })).toHaveCount(0);
  });

  test("a broken dependency graph locks ordering and says why", async ({ page }) => {
    const file = "docs/plans/backlog/alpha-diagnostics.md";
    try {
      write(file, document({ id: "alphax03", title: "Diagnostics", deps: ["missing9"] }));
      await openNamespace(page);
      await expect(page.getByText("alphax03 depends on missing9, which does not exist.")).toBeVisible();
      await page.getByRole("button", { name: "Ordering", exact: true }).click();
      await expect(page.getByText("alphax03 depends on missing9, which does not exist.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Move to top" })).toHaveCount(0);
      await expect(page.locator("backlog-block", { hasText: "ALPHA · Storage" })).toContainText("blocked");
    } finally {
      write(file, document({ id: "alphax03", title: "Diagnostics" }));
    }
  });

  test("other lifecycle tabs keep their flat cards, with no namespace prefix or ordering", async ({ page }) => {
    await page.goto(`/plans?lifecycle=active&repo=${await repoKey(page, repoName)}`);
    await expect(page.locator(".title-link")).toHaveText(["Working plan"]);
    await expect(page.getByRole("button", { name: "Ordering", exact: true })).toHaveCount(0);
    await expect(directoryRows(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  });
});
