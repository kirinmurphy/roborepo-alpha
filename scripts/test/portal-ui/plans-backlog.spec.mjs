// Backlog as a user drives it: repositories, then namespaces, then one list shown as Details or
// Prioritize, with order edits held in a draft until Save. The fixture repo has a two-plan chain, an
// independent ranked plan, and an unprioritized plan in `alpha`, a plan in `beta`, and one file whose
// prefix is not approved.
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { addRepositorySource, enablePlanBoard, portalToken, removeRepositorySources } from "./helpers.mjs";

const document = ({ id, title, deps = [], summary = `Purpose of ${title}.` }) => [
  "---", `id: ${id}`, "next_action: Do it", `depends_on: [${deps.join(", ")}]`, "---", "",
  `# ${title}`, "", "## Summary", "", summary, "",
].join("\n");

const GUARD = "Your prioritization changes have not been saved.";

// WCAG contrast of an element's text on its own fill. A canvas turns the computed color-mix() value
// into plain RGB, which is why this runs in the page.
const contrastRatio = (node) => {
  const context = Object.assign(document.createElement("canvas"), { width: 1, height: 1 }).getContext("2d");
  const luminance = (cssColor) => {
    context.fillStyle = cssColor;
    context.fillRect(0, 0, 1, 1);
    const channels = [...context.getImageData(0, 0, 1, 1).data].slice(0, 3).map((value) => {
      const unit = value / 255;
      return unit <= 0.03928 ? unit / 12.92 : ((unit + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * channels[0] + 0.7152 * channels[1] + 0.0722 * channels[2];
  };
  const style = getComputedStyle(node);
  const [low, high] = [luminance(style.color), luminance(style.backgroundColor)].sort((a, b) => a - b);
  return (high + 0.05) / (low + 0.05);
};

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
    write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one", deps: ["alphaa01"] }));
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
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await expect(page.locator("backlog-block").first()).toBeVisible();
  }
  const orderedList = (page) => page.getByRole("group", { name: "Prioritized plans" });
  // A row's own title, not the prerequisite links beside it, which name plans the same way.
  const orderedTitles = (page) => orderedList(page).locator(".backlog-plan-title");
  const directoryRows = (page) => page.getByRole("group", { name: "Backlog directory" }).getByRole("link");
  const blockFor = (page, title) => page.locator("backlog-block", { has: page.getByRole("button", { name: title, exact: true }) });
  const guardDialog = (page) => page.getByRole("dialog", { name: GUARD });
  const drawerHeading = (page, title) => page.getByRole("dialog").getByRole("heading", { level: 2, name: title, exact: true });
  const scrollsSideways = (page) => page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth);
  const waitingOn = (scope) => scope.getByRole("list", { name: "Waiting on", exact: true }).getByRole("listitem");
  // A prerequisite's badge is a link on Backlog's lists, but plain text with no role in the drawer, so it is found by its text.
  const prerequisiteBadge = (scope, namespace) => waitingOn(scope).getByText(namespace, { exact: true });

  test("repositories lead to namespaces, with No namespace last and counts of plans", async ({ page }) => {
    await page.goto("/plans?lifecycle=backlog");
    const repoRow = page.getByRole("link", { name: new RegExp(repoName) });
    await expect(repoRow).toContainText("2 ready · 2 unprioritized · 6 total");
    await expect(page.locator("plan-card")).toHaveCount(0);
    await repoRow.click();

    const rows = directoryRows(page);
    await expect(rows.nth(0)).toContainText("ALPHA");
    await expect(rows.nth(0)).toContainText("2 ready · 1 unprioritized · 4 total");
    await expect(rows.nth(1)).toContainText("BETA");
    // A count of zero drops out, and what remains still lines up at the right, pin or no pin.
    await expect(rows.nth(1).locator(".backlog-directory-counts")).toHaveText("1 unprioritized · 1 total");
    const countsRight = (row) => row.locator(".backlog-directory-counts").evaluate((node) => node.getBoundingClientRect().right);
    expect(await countsRight(rows.nth(1))).toBe(await countsRight(rows.nth(0)));
    await expect(rows.nth(2)).toContainText("No namespace");
    await expect(rows.nth(2)).toContainText("Repair needed · 1 total");
    expect(await countsRight(rows.nth(2))).toBe(await countsRight(rows.nth(0)));
    const label = rows.nth(0).locator(".backlog-directory-label");
    await expect(label).toHaveCSS("font-size", "14px");
    await expect(label).toHaveCSS("font-weight", "400");
    await expect(rows.nth(0).locator(".backlog-directory-counts")).toHaveCSS("font-size", "14px");
    await expect(page.locator(".backlog-breadcrumb-separator")).toHaveText(["›"]);

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
    await page.getByRole("searchbox").fill("Diagnostics");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    const rows = directoryRows(page);
    await expect(rows).toHaveCount(1);
    await expect(rows.first().locator(".backlog-directory-counts")).toHaveText("1 ready · 1 total");
  });

  test("filters narrow Details, and Prioritize shows the whole namespace regardless", async ({ page }) => {
    await openNamespace(page);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Retrieval");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(page.locator(".title-link")).toHaveText(["Retrieval"]);
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await expect(orderedTitles(page)).toHaveText(["Storage", "Retrieval", "Diagnostics"]);
    await expect(page.getByRole("button", { name: "Traces", exact: true })).toBeVisible();
    await expect(page.locator("filter-chip")).toHaveCount(0);
  });

  test("Details shows ordered cards with plain titles, and a banner for the rest that opens Prioritize", async ({ page }) => {
    await openNamespace(page);
    await expect(page.getByRole("heading", { name: /^(Needs prioritization|Prioritized)/ })).toHaveCount(0);
    await expect(page.locator(".title-link")).toHaveText(["Storage", "Retrieval", "Diagnostics"]);
    await expect(page.locator(".backlog-prioritize-banner")).toContainText("1 new plan needs prioritization");
    await expect(page.locator("backlog-block")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Move up" })).toHaveCount(0);
    await expect(page.getByText("linked plans")).toHaveCount(0);
    await page.getByRole("button", { name: "Prioritize Now", exact: true }).click();
    await expect(page.locator("backlog-block", { hasText: "Traces" })).toBeVisible();
  });

  test("Prioritize draws dependencies as a tree, with the implied link collapsed", async ({ page }, testInfo) => {
    // Joins needs Storage and Diagnostics; Finale needs Storage and Joins, which already implies Storage.
    const files = {
      "docs/plans/backlog/alpha-joins.md": document({ id: "alphaj10", title: "Joins", deps: ["alphaa01", "alphax03"] }),
      "docs/plans/backlog/alpha-finale.md": document({ id: "alphaf11", title: "Finale", deps: ["alphaa01", "alphaj10"] }),
    };
    try {
      for (const [file, content] of Object.entries(files)) write(file, content);
      await openOrdering(page);
      const block = blockFor(page, "Storage");
      await expect(block.locator(".backlog-plan-title")).toHaveText(["Storage", "Retrieval", "Diagnostics", "Joins", "Finale"]);
      const treeRow = (title) => block.locator(".backlog-tree-row", { has: page.locator(`.backlog-plan-title:text-is("${title}")`) });
      const guides = (title) => treeRow(title)
        .locator(".backlog-tree-guide").evaluateAll((nodes) => nodes.map((node) => node.dataset.line));
      expect(await guides("Storage")).toEqual([]);
      expect(await guides("Retrieval")).toEqual(["elbow"]);
      expect(await guides("Joins")).toEqual(["elbow"]);
      expect(await guides("Finale")).toEqual(["blank", "elbow"]);
      await expect(treeRow("Joins").getByRole("list", { name: "Also needs" })).toHaveText(/Storage/);
      await expect(block.getByRole("list", { name: "Also needs" })).toHaveCount(1);
      await expect(block.getByRole("list", { name: "Waiting on" })).toHaveCount(0);
      // The plan text starts at one place in every row, numbered, linked, or still to be prioritized.
      const textStart = (title) => page.locator(`.backlog-plan-title:text-is("${title}")`).evaluate((node) => Math.round(node.getBoundingClientRect().left));
      expect(await textStart("Traces")).toBe(await textStart("Storage"));
      const position = block.locator(".backlog-position");
      await expect(position).toHaveCSS("font-weight", "700");
      const edges = await position.evaluate((node) => {
        const cell = node.getBoundingClientRect();
        const body = node.parentElement.getBoundingClientRect();
        return { left: cell.left - body.left, top: cell.top - body.top, bottom: body.bottom - cell.bottom };
      });
      expect(edges).toEqual({ left: 1, top: 1, bottom: 1 });
    } finally {
      for (const file of Object.keys(files)) fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("dragging over an empty Prioritized list lights it up, and Save returns to Details", async ({ page }) => {
    setOrder([]);
    await openOrdering(page);
    const list = orderedList(page);
    await expect(page.getByRole("heading", { name: "Needs prioritization", exact: true })).toBeVisible();
    const handle = blockFor(page, "Diagnostics").getByRole("img", { name: "Drag to move" });
    await handle.hover();
    await page.mouse.down();
    await list.hover();
    await list.hover({ position: { x: 20, y: 10 } });
    await expect(list).toHaveClass(/is-drop-over/);
    await page.mouse.up();
    await expect(orderedTitles(page)).toHaveText(["Diagnostics"]);
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".title-link")).toHaveText(["Diagnostics"]);
    await expect(page.locator(".backlog-prioritize-banner")).toContainText("new plans need prioritization");
  });

  test("a sustained hover reads the description on over the page, with nothing moving", async ({ page }) => {
    const summary = Array.from({ length: 80 }, (_, index) => `word${index}`).join(" ");
    const file = "docs/plans/backlog/alpha-long.md";
    write(file, document({ id: "alphal09", title: "Long" }).replace("Purpose of Long.", summary));
    setOrder(["alphal09", "alphaa01", "alphab02", "alphax03"]);
    // Where every line of the preview sits, so a line that re-wraps or shifts fails the comparison.
    const previewLines = (description) => description.evaluate((node) => {
      const range = globalThis.document.createRange();
      range.selectNodeContents(node.firstChild);
      return [...range.getClientRects()].map(({ left, top, right }) => ({ left, top, right }));
    });
    const panelColors = [];
    const panelBackgrounds = [];
    const expectSeamless = async (region, description, next) => {
      const before = { lines: await previewLines(description), next: await next.boundingBox(), height: (await region.boundingBox()).height };
      const preview = await description.textContent();
      expect(preview.endsWith("…")).toBe(true);
      expect(preview.length).toBeLessThanOrEqual(191);

      const hoverStart = Date.now();
      await description.hover();
      await expect(region).toHaveClass(/is-excerpt-expanded/);
      expect(Date.now() - hoverStart).toBeGreaterThan(900);
      panelColors.push(await description.evaluate((node) => getComputedStyle(node).color));
      panelBackgrounds.push(await region.evaluate((node) => getComputedStyle(node).backgroundColor));

      const longer = await description.textContent();
      expect(longer.startsWith(preview.slice(0, -1))).toBe(true);
      expect(longer.length).toBeGreaterThan(300);
      expect(longer.length).toBeLessThanOrEqual(381);
      expect(await previewLines(description)).toEqual(before.lines);
      expect(await next.boundingBox()).toEqual(before.next);
      expect((await region.boundingBox()).height).toBeGreaterThan(before.height);

      await page.mouse.move(0, 0);
      await expect(region).not.toHaveClass(/is-excerpt-expanded/);
      expect(await description.textContent()).toBe(preview);
      expect(await next.boundingBox()).toEqual(before.next);
    };
    try {
      await openNamespace(page);
      const card = page.locator("plan-card", { hasText: "Long" });
      const cardDescription = card.locator(".description-line");
      await expect(cardDescription).toHaveCSS("font-size", "15px");
      await expectSeamless(card.locator(".doc-details"), cardDescription, page.locator("plan-card").nth(1));

      await page.getByRole("button", { name: "Prioritize", exact: true }).click();
      const row = blockFor(page, "Long");
      const rowDescription = row.locator(".backlog-plan-purpose");
      await expect(rowDescription).toHaveCSS("font-size", "15px");
      await expectSeamless(row.locator(".backlog-plan-doc"), rowDescription, blockFor(page, "Storage"));
      expect(panelColors[1]).toBe(panelColors[0]);
      expect(panelBackgrounds[1]).toBe(panelBackgrounds[0]);

      // The description is part of what opens the plan, not only the title.
      await rowDescription.click();
      await expect(drawerHeading(page, "Long")).toBeVisible();
    } finally {
      fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("the namespace dropdown is a bare caret, and the view toggle answers hover", async ({ page }) => {
    await openNamespace(page);
    const trigger = page.getByRole("navigation", { name: "Backlog location" }).getByRole("button", { name: "Namespace: ALPHA" });
    await expect(trigger).toHaveCSS("border-top-style", "none");
    await expect(trigger).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
    const prioritize = page.getByRole("button", { name: "Prioritize", exact: true });
    const resting = await prioritize.evaluate((node) => getComputedStyle(node).backgroundColor);
    await prioritize.hover();
    await expect(prioritize).not.toHaveCSS("background-color", resting);
  });

  test("other lifecycles keep the larger description, with no hover expansion", async ({ page }) => {
    await page.goto(`/plans?lifecycle=active&repo=${await repoKey(page, repoName)}`);
    const card = page.locator("plan-card", { hasText: "Working plan" });
    await expect(card.locator(".description-line")).toHaveCSS("font-size", "17px");
  });

  test("a namespace with only new plans opens in Prioritize, and Details stays reachable", async ({ page }) => {
    setOrder([]);
    await openNamespace(page);
    const details = page.getByRole("button", { name: "Details", exact: true });
    const ordering = page.getByRole("button", { name: "Prioritize", exact: true });
    await expect(ordering).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByRole("heading", { name: "Needs prioritization", exact: true })).toBeVisible();
    await details.click();
    await expect(details).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".backlog-prioritize-banner")).toBeVisible();
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(details).toHaveAttribute("aria-pressed", "true");
  });

  test("Waiting on starts level with the card's menu button, however many prerequisites it lists", async ({ page }) => {
    const file = "docs/plans/backlog/alpha-retrieval.md";
    const centers = async () => {
      const card = page.locator("plan-card", { hasText: "Retrieval" });
      const middle = (box) => box.y + box.height / 2;
      return {
        menu: middle(await card.getByRole("button", { name: "Plan actions", exact: true }).boundingBox()),
        first: middle(await waitingOn(card).first().boundingBox()),
      };
    };
    await openNamespace(page);
    const one = await centers();
    expect(Math.abs(one.menu - one.first)).toBeLessThanOrEqual(2);
    write(file, document({ id: "alphab02", title: "Retrieval", deps: ["alphaa01", "alphax03"] }));
    try {
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(waitingOn(page.locator("plan-card", { hasText: "Retrieval" }))).toHaveCount(2);
      const two = await centers();
      // The card moves in the list, so the check is the button against the first prerequisite.
      expect(two.menu - two.first).toBe(one.menu - one.first);
    } finally {
      write(file, document({ id: "alphab02", title: "Retrieval", deps: ["alphaa01"] }));
    }
  });

  test("the breadcrumb underlines its links and keeps one height at every level", async ({ page }) => {
    const nav = page.getByRole("navigation", { name: "Backlog location" });
    const rowHeight = () => nav.evaluate((node) => (node.closest(".backlog-namespace-header") || node).getBoundingClientRect().height);
    // Where the first crumb's text sits: the trail must not move when the mode toggle appears.
    const crumbTop = () => nav.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node.firstElementChild);
      return range.getBoundingClientRect().top;
    });
    await page.goto("/plans?lifecycle=backlog");
    const heights = [await rowHeight()];
    const tops = [await crumbTop()];
    await page.getByRole("link", { name: new RegExp(repoName) }).click();
    await expect(nav.getByRole("link", { name: "All repos" })).toHaveCSS("text-decoration-line", "underline");
    heights.push(await rowHeight());
    tops.push(await crumbTop());
    await directoryRows(page).first().click();
    await expect(nav.getByRole("link", { name: repoName })).toHaveCSS("text-decoration-line", "underline");
    await expect(page.getByRole("button", { name: "Prioritize", exact: true })).toBeVisible();
    heights.push(await rowHeight());
    tops.push(await crumbTop());
    expect(new Set(heights).size, `heights ${heights}`).toBe(1);
    expect(new Set(tops).size, `tops ${tops}`).toBe(1);

    // The whole row sits on the repo filter's band, and the toggle reads at the breadcrumb's size.
    const band = await page.locator(".repository-scope-bar").evaluate((node) => getComputedStyle(node).backgroundColor);
    await expect(page.locator(".backlog-namespace-header")).toHaveCSS("background-color", band);
    await expect(page.getByRole("button", { name: "Prioritize", exact: true })).toHaveCSS("font-size", await nav.evaluate((node) => getComputedStyle(node).fontSize));

    // Square, and hung straight off the lifecycle row's border.
    const header = page.locator(".backlog-namespace-header");
    await expect(header).toHaveCSS("border-top-left-radius", "0px");
    const barBox = await page.locator("#lifecycle-bar").boundingBox();
    expect((await header.boundingBox()).y).toBeCloseTo(barBox.y + barBox.height, 0);

    // The middle of the capital letters, from the font's own metrics, is what the eye lines up.
    const capitalCenter = (locator) => locator.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const box = range.getBoundingClientRect();
      const style = getComputedStyle(node);
      const context = document.createElement("canvas").getContext("2d");
      context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
      const metrics = context.measureText("H");
      return box.top + metrics.fontBoundingBoxAscent - metrics.actualBoundingBoxAscent / 2;
    });
    const offset = await capitalCenter(nav.getByRole("link", { name: repoName })) - await capitalCenter(page.getByRole("button", { name: "Prioritize", exact: true }));
    expect(Math.abs(offset), `offset ${offset}`).toBeLessThan(0.5);
    await expect(nav.locator(".dropdown-chevron")).toHaveCSS("translate", "0px -2px");

    // Every part reads at one size, with its carets easy to see and room around each.
    const link = nav.getByRole("link", { name: repoName });
    const namespace = nav.locator(".dropdown-trigger");
    const size = await link.evaluate((node) => getComputedStyle(node).fontSize);
    await expect(namespace).toHaveCSS("font-size", size);
    const separator = nav.locator(".backlog-breadcrumb-separator").first();
    await expect(separator).toHaveCSS("font-size", size);
    await expect(separator).toHaveCSS("margin-left", "6px");
    const ink = await page.evaluate(() => {
      const probe = document.body.appendChild(Object.assign(document.createElement("span"), { style: "color: var(--ink)" }));
      const color = getComputedStyle(probe).color;
      probe.remove();
      return color;
    });
    await expect(separator).toHaveCSS("color", ink);

    // A dropdown crumb's hover underlines it and leaves its color alone.
    const namespaceLabel = namespace.locator(".dropdown-label");
    await expect(namespaceLabel).toHaveCSS("text-decoration-line", "none");
    const color = await namespace.evaluate((node) => getComputedStyle(node).color);
    await namespace.hover();
    await expect(namespaceLabel).toHaveCSS("text-decoration-line", "underline");
    // Only the label: an underline on the trigger would also run under the caret.
    await expect(namespace).toHaveCSS("text-decoration-line", "none");
    await expect(namespace).toHaveCSS("color", color);
  });

  test("the namespace breadcrumb switches namespaces, and guards a dirty draft", async ({ page }) => {
    await openOrdering(page);
    const nav = page.getByRole("navigation", { name: "Backlog location" });
    const trigger = nav.getByRole("button", { name: "Namespace: ALPHA" });
    await trigger.click();
    await expect(nav.getByRole("option")).toHaveText(["ALPHA", "BETA", "No namespace"]);
    await nav.getByRole("option", { name: "BETA" }).click();
    await expect(page).toHaveURL(/namespace=beta/);
    await expect(page.locator(".title-link")).toHaveCount(0);

    await nav.getByRole("button", { name: "Namespace: BETA" }).click();
    await nav.getByRole("option", { name: "ALPHA" }).click();
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await nav.getByRole("button", { name: "Namespace: ALPHA" }).click();
    await nav.getByRole("option", { name: "BETA" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page).toHaveURL(/namespace=alpha/);
    await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
  });

  test("the repo breadcrumb switches repos only where the trail stops at the repo", async ({ page }) => {
    await openNamespace(page);
    const nav = page.getByRole("navigation", { name: "Backlog location" });
    await expect(nav.getByRole("link", { name: repoName })).toBeVisible();
    await expect(nav.getByRole("button", { name: /^Repo: / })).toHaveCount(0);

    await nav.getByRole("link", { name: repoName }).click();
    await nav.getByRole("button", { name: `Repo: ${repoName}` }).click();
    await nav.getByRole("option", { name: bareName }).click();
    await expect(page).toHaveURL(new RegExp(`repo=${await repoKey(page, bareName)}`));
    await expect(nav.getByRole("button", { name: `Repo: ${bareName}` })).toBeVisible();
  });

  test("namespace rows end in the pin, with no caret, and Next up's tip says category", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const item = page.locator(".backlog-directory-item", { hasText: "ALPHA" });
    await expect(item.locator(".backlog-directory-chevron")).toHaveCount(0);
    await expect(item.locator(":scope > :last-child")).toHaveClass(/backlog-pin/);
    const info = page.getByRole("region", { name: "Next up" }).getByRole("button", { name: /^Next up: / });
    await expect(info).toHaveAttribute("aria-label", /for each category below/);
    await expect(info).toHaveCSS("width", "16px");
    // The host holds only its icon, with no line box to leave the icon low beside the title.
    const middle = (box) => box.y + box.height / 2;
    const heading = page.getByRole("heading", { name: "Next up", exact: true });
    expect(Math.abs(middle(await info.boundingBox()) - middle(await heading.boundingBox()))).toBeLessThan(0.5);
    const nextUpBottom = (await page.getByRole("region", { name: "Next up" }).boundingBox());
    const allPlansTop = (await page.getByRole("heading", { name: "All Plans", exact: true }).boundingBox()).y;
    expect(allPlansTop - (nextUpBottom.y + nextUpBottom.height)).toBeCloseTo(32, 0);
    const crumbs = await page.locator(".groups > .backlog-breadcrumb").boundingBox();
    expect(nextUpBottom.y - (crumbs.y + crumbs.height)).toBeCloseTo(32, 0);
  });

  test("Prioritize rows show the plan's age beside its title, aligned to the top", async ({ page }) => {
    await openOrdering(page);
    const row = blockFor(page, "Diagnostics");
    const age = row.locator("time[data-slot=modified]");
    await expect(age).toHaveText(/^(now|\d+ \w+)$/);
    await expect(age).toHaveAttribute("aria-label", /^Modified /);
    const title = await row.getByRole("button", { name: "Diagnostics", exact: true }).boundingBox();
    expect((await age.boundingBox()).x).toBeGreaterThan(title.x + title.width);
    await expect(row.locator(".backlog-block-body")).toHaveCSS("align-items", "start");
  });

  test("hovering a Prioritize row underlines its title and paints no background", async ({ page }) => {
    await openOrdering(page);
    const row = blockFor(page, "Diagnostics");
    const title = row.getByRole("button", { name: "Diagnostics", exact: true });
    await title.hover();
    await expect(title).toHaveCSS("text-decoration-line", "underline");
    await expect(row.locator(".backlog-plan-doc")).toHaveCSS("background-color", "rgba(0, 0, 0, 0)");
  });

  test("an unprioritized row centers its title, age, and archive icon, evenly spaced", async ({ page }) => {
    await openOrdering(page);
    const row = blockFor(page, "Traces");
    const textBox = (locator) => locator.evaluate((node) => {
      const range = document.createRange();
      range.selectNodeContents(node);
      const { top, bottom, left, right } = range.getBoundingClientRect();
      return { middle: (top + bottom) / 2, left, right };
    });
    const iconBox = async (locator) => {
      const box = await locator.boundingBox();
      return { middle: box.y + box.height / 2, left: box.x, right: box.x + box.width };
    };
    const title = await textBox(row.getByRole("button", { name: "Traces", exact: true }));
    const clock = await iconBox(row.locator("time[data-slot=modified] portal-icon"));
    const age = await textBox(row.locator("time[data-slot=modified] [data-slot=meta]"));
    const trash = await iconBox(row.getByRole("button", { name: "Archive Traces", exact: true }).locator("portal-icon"));
    for (const item of [clock, age, trash]) expect(Math.abs(item.middle - title.middle)).toBeLessThan(1);
    expect(clock.left - title.right).toBeCloseTo(12, 0);
    expect(trash.left - age.right).toBeCloseTo(12, 0);
  });

  test("Needs prioritization and Prioritized sit as far apart as Next up and All Plans", async ({ page }) => {
    await openOrdering(page);
    const needs = await page.locator(".backlog-section", { has: page.getByRole("heading", { name: "Needs prioritization", exact: true }) }).boundingBox();
    const prioritizedTop = (await page.getByRole("heading", { name: "Prioritized", exact: true }).boundingBox()).y;
    expect(prioritizedTop - (needs.y + needs.height)).toBeCloseTo(32, 0);
  });

  test("a prioritized plan returns to unprioritized by its control or the drop zone, on Save", async ({ page }) => {
    await openOrdering(page);
    const needs = page.locator(".backlog-section", { has: page.getByRole("heading", { name: "Needs prioritization", exact: true }) }).locator(".backlog-plan-title");
    const zone = page.getByText("Return to unprioritized", { exact: true });
    await expect(needs).toHaveText(["Traces"]);

    await blockFor(page, "Diagnostics").getByRole("button", { name: "Return to unprioritized" }).click();
    await expect(needs).toHaveText(["Diagnostics", "Traces"]);
    await expect(orderedTitles(page)).toHaveText(["Storage", "Retrieval"]);
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);

    // A linked group goes back whole, and the file changes only on Save.
    await blockFor(page, "Storage").getByRole("img", { name: "Drag to move" }).dragTo(zone);
    await expect(needs).toHaveText(["Storage", "Retrieval", "Diagnostics", "Traces"]);
    await expect(zone).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(JSON.parse(fs.readFileSync(orderFile, "utf8")).namespaces.alpha).toBeUndefined();
    await expect(page.getByText("4 new plans need prioritization")).toBeVisible();
  });

  test("the sustained-hover panel is the default in every lifecycle", async ({ page }) => {
    write("docs/plans/active/alpha-long-active.md", [
      "---", "id: alphaz11", "next_action: Do it", "depends_on: []", "---", "",
      "# Long active plan", "", "## Summary", "", "word ".repeat(90).trim(), "",
    ].join("\n"));
    try {
      await page.goto("/plans?lifecycle=active");
      const card = page.locator("plan-card", { hasText: "Long active plan" });
      const region = card.locator(".doc-details");
      const description = card.getByText(/^word word/);
      const before = await region.boundingBox();
      const preview = await description.textContent();
      expect(preview.endsWith("…")).toBe(true);
      await description.hover();
      await expect(region).toHaveClass(/is-excerpt-expanded/);
      await expect(region).toHaveCSS("padding-top", "28px");
      const fill = (node) => getComputedStyle(node).backgroundColor;
      expect(await region.evaluate(fill)).toBe(await page.locator("#plans-header").evaluate(fill));
      const panel = await region.boundingBox();
      expect(panel.x).toBeLessThan(before.x);
      expect(panel.height).toBeGreaterThan(before.height);
      await page.mouse.move(0, 0);
      await expect(region).not.toHaveClass(/is-excerpt-expanded/);
    } finally {
      fs.rmSync(path.join(repo, "docs/plans/active/alpha-long-active.md"));
    }
  });

  test("a failed archive names no absolute path and leaves the plan where it was", async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-archive-failure-"));
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
    const put = (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    };
    const dependent = path.join(root, "docs/plans/backlog/beta-after.md");
    const lock = path.join(root, ".git/index.lock");
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Portal Test");
      git("config", "user.email", "portal@example.invalid");
      put("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A", beta: "B" } }));
      put("docs/plans/backlog/alpha-free.md", document({ id: "failfree1", title: "Free one" }));
      put("docs/plans/backlog/beta-after.md", document({ id: "failafter", title: "Waits elsewhere", deps: ["failfree1"] }));
      git("add", ".");
      git("commit", "-q", "-m", "fixture");
      await addRepositorySource(page, root);
      const { backlog } = await (await page.request.get("/api/plans")).json();
      const { repositoryId } = backlog.find((item) => item.name === path.basename(root));
      const token = await portalToken(page);
      const archive = async () => {
        const response = await page.request.post("/api/plans/archive", {
          headers: { "X-Cli-Portal-Token": token },
          data: { repositoryId, id: "failfree1", reason: "Abandoned." },
        });
        return { status: response.status(), text: await response.text() };
      };
      const expectUnchanged = () => {
        expect(fs.existsSync(path.join(root, "docs/plans/backlog/alpha-free.md"))).toBe(true);
        expect(git("status", "--porcelain")).toBe("");
      };

      // Git's own message for a held lock names the lock file's full path.
      fs.writeFileSync(lock, "");
      const locked = await archive();
      fs.rmSync(lock);
      expect(locked.status).toBe(500);
      expect(locked.text).toContain("could not be archived");
      expect(locked.text).not.toContain(path.basename(root));
      expectUnchanged();

      fs.chmodSync(dependent, 0o444);
      const readOnly = await archive();
      fs.chmodSync(dependent, 0o644);
      expect(readOnly.status).toBe(400);
      expect(readOnly.text).toContain("could not be updated (EACCES)");
      expect(readOnly.text).not.toContain(path.basename(root));
      expectUnchanged();

      expect((await archive()).status).toBe(200);
      expect(fs.existsSync(path.join(root, "docs/plans/archived/alpha-free.md"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("archiving an unprioritized plan asks twice, records the reason, and clears what depended on it", async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-archive-"));
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
    const put = (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    };
    const moved = (name) => path.join(root, "docs/plans/archived", name);
    try {
      git("init", "-q", "-b", "main");
      git("config", "user.name", "Portal Test");
      git("config", "user.email", "portal@example.invalid");
      put("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A", beta: "B" } }));
      put("docs/plans/backlog/alpha-ranked.md", document({ id: "arkranked", title: "Ranked one" }));
      put("docs/plans/backlog/alpha-free.md", document({ id: "arkfree01", title: "Free one" }));
      put("docs/plans/backlog/alpha-long.md", document({ id: "arklong01", title: "Long one", summary: "A description long enough to need the sustained hover. ".repeat(10) }));
      put("docs/plans/backlog/alpha-root.md", document({ id: "arkroot01", title: "Chain root" }));
      put("docs/plans/backlog/alpha-leaf.md", document({ id: "arkleaf01", title: "Chain leaf", deps: ["arkroot01"] }));
      put("docs/plans/backlog/beta-after.md", document({ id: "arkafter1", title: "Waits elsewhere", deps: ["arkfree01"] }));
      git("add", ".");
      git("commit", "-q", "-m", "fixture");
      put("docs/plans/plans-order.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ["arkranked"] } }));
      await addRepositorySource(page, root);

      const { backlog } = await (await page.request.get("/api/plans")).json();
      const entry = backlog.find((item) => item.name === path.basename(root));
      await page.goto(`/plans?lifecycle=backlog&repo=${entry.urlKey}&namespace=alpha`);
      await page.getByRole("button", { name: "Prioritize", exact: true }).click();

      const archive = (title) => page.getByRole("button", { name: `Archive ${title}`, exact: true });
      await expect(blockFor(page, "Ranked one").getByRole("button", { name: /^Archive/ })).toHaveCount(0);
      // A linked block offers one control per plan, and none among its moves.
      await expect(blockFor(page, "Chain root").getByRole("button", { name: /^Archive/ })).toHaveCount(2);
      await expect(blockFor(page, "Chain root").getByRole("group", { name: "Move" }).getByRole("button", { name: /^Archive/ })).toHaveCount(0);

      // An unsaved draft would go stale, so the control waits.
      await blockFor(page, "Chain root").getByRole("button", { name: "Move down" }).click();
      await expect(archive("Free one")).toBeDisabled();
      // Disabled, the button still shows no longer text and opens nothing.
      const disabledRow = page.locator(".backlog-plan-doc", { has: archive("Long one") });
      const box = await archive("Long one").boundingBox();
      await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForTimeout(1200);
      await expect(disabledRow).not.toHaveClass(/is-excerpt-expanded/);
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await expect(page.locator("#drawer")).not.toHaveAttribute("open");
      await page.mouse.move(0, 0);
      await page.getByRole("button", { name: "Cancel", exact: true }).click();

      // The button lives inside the row's opening area, and is not part of it: no drawer, no longer text.
      const row = page.locator(".backlog-plan-doc", { has: archive("Long one") });
      await archive("Long one").hover();
      await page.waitForTimeout(1200);
      await expect(row).not.toHaveClass(/is-excerpt-expanded/);
      await archive("Long one").click();
      await expect(page.getByRole("dialog", { name: 'Archive "Long one"?' })).toBeVisible();
      await expect(page.locator("#drawer")).not.toHaveAttribute("open");
      await page.getByRole("dialog", { name: 'Archive "Long one"?' }).getByRole("button", { name: "Cancel" }).click();
      await row.locator("[data-slot=purpose]").hover();
      await expect(row).toHaveClass(/is-excerpt-expanded/, { timeout: 3000 });
      await page.mouse.move(0, 0);

      const first = page.getByRole("dialog", { name: 'Archive "Free one"?' });
      const second = page.getByRole("dialog", { name: "Are you sure?" });
      await archive("Free one").click();
      await expect(first.getByRole("button", { name: "Continue" })).toBeDisabled();
      // Actions sit in one row at the right, Cancel first, and the field has room around its text.
      const cancelBox = await first.getByRole("button", { name: "Cancel" }).boundingBox();
      const continueBox = await first.getByRole("button", { name: "Continue" }).boundingBox();
      expect(cancelBox.y).toBe(continueBox.y);
      expect(cancelBox.x).toBeLessThan(continueBox.x);
      expect(await first.getByRole("textbox").evaluate((node) => parseFloat(getComputedStyle(node).paddingLeft))).toBeGreaterThanOrEqual(8);
      await first.getByRole("textbox").fill("Superseded by the ranked plan.");
      await first.getByRole("button", { name: "Continue" }).click();
      await expect(second).toContainText("commits the move");
      await expect(second).toContainText("No longer depending on it: Waits elsewhere.");
      await second.getByRole("button", { name: "Cancel" }).click();
      await expect(second).toBeHidden();
      expect(fs.existsSync(path.join(root, "docs/plans/backlog/alpha-free.md"))).toBe(true);

      await archive("Free one").click();
      await expect(first.getByRole("textbox")).toHaveValue("");
      await first.getByRole("textbox").fill("Superseded by the ranked plan.");
      await first.getByRole("button", { name: "Continue" }).dblclick();
      // The final button can land under the cursor, so a double-click must not answer both questions.
      await expect(second.getByRole("button", { name: "Archive Plan" })).toBeDisabled();
      expect(fs.existsSync(path.join(root, "docs/plans/backlog/alpha-free.md"))).toBe(true);
      await second.getByRole("button", { name: "Archive Plan" }).click();
      await expect(second).toBeHidden();
      await expect(blockFor(page, "Free one")).toHaveCount(0);
      expect(fs.readFileSync(moved("alpha-free.md"), "utf8")).toContain("Superseded by the ranked plan.");
      expect(git("show", "--no-renames", "--name-only", "--format=", "HEAD").trim().split("\n").sort()).toEqual(["docs/plans/archived/alpha-free.md", "docs/plans/backlog/alpha-free.md", "docs/plans/backlog/beta-after.md"]);
      expect(fs.readFileSync(path.join(root, "docs/plans/backlog/beta-after.md"), "utf8")).toMatch(/^depends_on: \[\]$/m);
      expect(git("status", "--porcelain").trim()).toBe("?? docs/plans/plans-order.json");

      // One plan of a linked block goes alone; the survivor stops depending on it and stays.
      await archive("Chain root").click();
      const linked = page.getByRole("dialog", { name: 'Archive "Chain root"?' });
      await linked.getByRole("textbox").fill("Abandoned.");
      await linked.getByRole("button", { name: "Continue" }).click();
      await expect(second).toContainText("No longer depending on it: Chain leaf.");
      await second.getByRole("button", { name: "Archive Plan" }).click();
      await expect(second).toBeHidden();
      expect(fs.existsSync(moved("alpha-root.md"))).toBe(true);
      await expect(archive("Chain leaf")).toBeEnabled();
      expect(fs.readFileSync(path.join(root, "docs/plans/backlog/alpha-leaf.md"), "utf8")).toMatch(/^depends_on: \[\]$/m);

      // The route itself refuses a ranked plan, whatever a page sends.
      const refused = await page.evaluate(async (repositoryId) => {
        const { portalPostJson } = await import("/portal/shared/api.js");
        return portalPostJson("/api/plans/archive", { repositoryId, id: "arkranked", reason: "No." }).catch((err) => err.message);
      }, entry.repositoryId);
      expect(refused).toContain("Only unprioritized Backlog plans");
      expect(fs.existsSync(path.join(root, "docs/plans/backlog/alpha-ranked.md"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("archiving works on a repo whose base branch is not main, and waits for the new snapshot", async ({ page }) => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "portal-ui-trunk-"));
    const git = (...args) => spawnSync("git", args, { cwd: root, encoding: "utf8" }).stdout;
    const put = (relative, content) => {
      fs.mkdirSync(path.dirname(path.join(root, relative)), { recursive: true });
      fs.writeFileSync(path.join(root, relative), content);
    };
    try {
      git("init", "-q", "-b", "trunk");
      git("config", "user.name", "Portal Test");
      git("config", "user.email", "portal@example.invalid");
      put("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A" } }));
      put("docs/plans/backlog/alpha-free.md", document({ id: "trkfree01", title: "Free one" }));
      put("docs/plans/backlog/alpha-next.md", document({ id: "trknext01", title: "Next one" }));
      git("add", ".");
      git("commit", "-q", "-m", "fixture");
      git("update-ref", "refs/remotes/origin/trunk", "HEAD");
      git("symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
      await addRepositorySource(page, root);

      const { backlog } = await (await page.request.get("/api/plans")).json();
      const entry = backlog.find((item) => item.name === path.basename(root));
      await page.goto(`/plans?lifecycle=backlog&repo=${entry.urlKey}&namespace=alpha`);
      const archiveThrough = async (title) => {
        await page.getByRole("button", { name: `Archive ${title}`, exact: true }).click();
        const first = page.getByRole("dialog", { name: `Archive "${title}"?` });
        await first.getByRole("textbox").fill("Superseded.");
        await first.getByRole("button", { name: "Continue" }).click();
        const second = page.getByRole("dialog", { name: "Are you sure?" });
        await expect(second.getByRole("button", { name: "Archive Plan" })).toBeEnabled();
        await second.getByRole("button", { name: "Archive Plan" }).click();
        return second;
      };

      const release = await holdRefresh(page);
      const dialog = await archiveThrough("Free one");
      await expect.poll(() => fs.existsSync(path.join(root, "docs/plans/archived/alpha-free.md"))).toBe(true);
      await expect(dialog).toBeVisible();
      release();
      await expect(dialog).toBeHidden();
      await expect(blockFor(page, "Free one")).toHaveCount(0);
      expect(git("rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("trunk");
      expect(git("log", "-1", "--format=%s", "trunk").trim()).not.toBe("fixture");

      // The base branch check itself still stands: another branch checked out refuses the move.
      await page.unrouteAll({ behavior: "ignoreErrors" });
      git("switch", "-qc", "feature");
      const refused = await archiveThrough("Next one");
      await expect(refused.getByText(/on feature, not trunk/)).toBeVisible();
      expect(fs.existsSync(path.join(root, "docs/plans/backlog/alpha-next.md"))).toBe(true);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  test("Prioritize draws linked plans as one block with exact controls and hides Filters", async ({ page }) => {
    await openOrdering(page);
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeHidden();
    const group = blockFor(page, "Storage");
    await expect(group).not.toContainText("linked plans");
    await expect(group).toContainText("Retrieval");
    await expect(group).not.toContainText("Waiting on");
    const names = (locator) => locator.locator("[aria-label]").evaluateAll((nodes) => nodes.map((node) => node.getAttribute("aria-label")));
    const ranked = ["Move to top", "Move up", "Move down", "Move to bottom", "Return to unprioritized", "Drag to move"];
    await expect.poll(() => names(group.getByRole("group", { name: "Move" }))).toEqual(ranked);
    await expect(group.getByRole("group", { name: "Move" })).toHaveCount(1);
    await expect.poll(() => names(blockFor(page, "Diagnostics").getByRole("group", { name: "Move" }))).toEqual(ranked);
    await expect.poll(() => names(blockFor(page, "Traces").getByRole("group", { name: "Move" }))).toEqual(["Move down", "Move to bottom", "Drag to move"]);
    await expect(group.getByRole("button", { name: "Move up" })).toBeDisabled();
    await expect(blockFor(page, "Diagnostics").getByRole("button", { name: "Move to bottom" })).toBeDisabled();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test("a prerequisite in another namespace shows its badge and title, and opens", async ({ page }) => {
    fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ["alphaa01", "alphab02", "alphax03"], beta: ["betaon05"] } }));
    await openNamespace(page, "beta");
    const card = page.locator("plan-card");
    await expect(card).toContainText("Waiting on:");
    await expect(waitingOn(card)).toHaveText(/^\s*alpha\s+Storage\s+\(Backlog\)\s*$/);
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    const block = blockFor(page, "Beta one");
    await expect(waitingOn(block)).toHaveText(/^\s*alpha\s+Storage\s+\(Backlog\)\s*$/);
    await block.getByRole("button", { name: "Storage", exact: true }).click();
    await expect(drawerHeading(page, "Storage")).toBeVisible();
  });

  test("a Waiting on namespace badge on a card opens that namespace, from Details and Next up", async ({ page }) => {
    fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ["alphax03"], beta: ["betaon05"] } }));
    const location = page.getByRole("navigation", { name: "Backlog location" });
    await openNamespace(page, "beta");
    await waitingOn(page.locator("plan-card")).getByRole("link", { name: "alpha", exact: true }).click();
    await expect(location).toContainText("ALPHA");
    expect(new URL(page.url()).searchParams.get("namespace")).toBe("alpha");

    // Beta one is held up by Storage, which is unprioritized Backlog work, so make it wait on Active work to reach Next up.
    write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one", deps: ["alphaw07"] }));
    try {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      const nextUpCard = page.getByRole("region", { name: "Next up" }).locator("plan-card", { hasText: "Beta one" });
      await waitingOn(nextUpCard).getByRole("link", { name: "alpha", exact: true }).click();
      await expect(location).toContainText("ALPHA");
    } finally {
      write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one", deps: ["alphaa01"] }));
    }
  });

  test("inside a namespace, its breadcrumb names it and only prerequisites carry a badge", async ({ page }) => {
    await openNamespace(page);
    await expect(page.getByRole("navigation", { name: "Backlog location" })).toContainText("ALPHA");
    const card = page.locator("plan-card", { hasText: "Diagnostics" });
    await expect(card.locator(".title-link")).toHaveText("Diagnostics");
    await expect(card.getByRole("link", { name: "alpha", exact: true })).toHaveCount(0);
    const retrieval = page.locator("plan-card", { hasText: "Retrieval" });
    await expect(waitingOn(retrieval)).toHaveText(/Storage/);
    await expect(prerequisiteBadge(retrieval, "alpha")).toHaveCount(0);
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await expect(blockFor(page, "Diagnostics").getByText("alpha", { exact: true })).toHaveCount(0);
    await expect(blockFor(page, "Storage").getByText("alpha", { exact: true })).toHaveCount(0);
  });

  test("Next up leads the repo view with full cards of each namespace's first ranked, unblocked plan", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const nextUp = page.getByRole("region", { name: "Next up" });
    const headings = page.getByRole("heading", { name: /^(Next up|All Plans)$/ });
    await expect(headings).toHaveText(["Next up", "All Plans"]);
    await nextUp.getByRole("button", { name: /^Next up: / }).hover();
    await expect(page.getByRole("tooltip")).toContainText("next priority plan for each category below");
    await expect(nextUp.locator("plan-card .title-link")).toHaveText(["Storage"]);
    await expect(nextUp.locator("plan-card")).toContainText("Purpose of Storage.");
    await expect(nextUp.getByRole("button", { name: "Promote", exact: true })).toBeVisible();
    await expect(nextUp.getByRole("button", { name: /^Move/ })).toHaveCount(0);

    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Diagnostics");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(nextUp.locator("plan-card .title-link")).toHaveText(["Diagnostics"]);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Traces");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await expect(directoryRows(page)).toHaveCount(1);
    await expect(nextUp).toHaveCount(0);
  });

  test("the Blockers filter and the ready count agree with Waiting on", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const row = (name) => directoryRows(page).filter({ hasText: name });
    // Beta one waits on a Backlog plan and is not ranked, so beta has no ready plan.
    await expect(row("BETA").locator(".backlog-directory-counts")).toHaveText("1 unprioritized · 1 total");
    const chooseBlockers = async (value) => {
      await page.getByRole("button", { name: "Filters", exact: true }).click();
      await page.locator("#blocked").selectOption(value);
      await page.getByRole("button", { name: "Update", exact: true }).click();
    };
    await chooseBlockers("unblocked");
    await expect(row("BETA")).toHaveCount(0);
    await expect(row("ALPHA")).toContainText("2 ready · 1 unprioritized · 3 total");
    await chooseBlockers("blocked");
    await expect(row("BETA")).toHaveCount(1);
    await expect(row("ALPHA")).not.toContainText("ready");
  });

  test("a count's number is bold and at full contrast, and section titles match it", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const number = directoryRows(page).first().locator(".backlog-directory-counts strong").first();
    await expect(number).toHaveCSS("font-weight", "700");
    const inkOf = () => page.evaluate(() => {
      const probe = document.createElement("span");
      probe.style.color = "var(--ink)";
      document.body.append(probe);
      const { color } = getComputedStyle(probe);
      probe.remove();
      return color;
    });
    await expect(number).toHaveCSS("color", await inkOf());
    await expect(page.getByRole("heading", { name: "All Plans", exact: true })).toHaveCSS("color", await inkOf());
  });

  test("pinning a namespace lifts it and its plan to the top, and survives a reload", async ({ page }) => {
    write("docs/plans/backlog/beta-free.md", document({ id: "betafr09", title: "Beta free" }));
    fs.writeFileSync(orderFile, `${JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ["alphaa01", "alphab02", "alphax03"], beta: ["betafr09"] } }, null, 2)}\n`);
    try {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      const labels = page.getByRole("group", { name: "Backlog directory" }).locator(".backlog-directory-label");
      const nextUp = page.getByRole("region", { name: "Next up" }).locator("plan-card .title-link");
      await expect(labels).toHaveText(["ALPHA", "BETA", "No namespace"]);
      await expect(nextUp).toHaveText(["Storage", "Beta free"]);

      await page.getByRole("button", { name: "Pin BETA", exact: true }).click();
      await expect(labels).toHaveText(["BETA", "ALPHA", "No namespace"]);
      await expect(nextUp).toHaveText(["Beta free", "Storage"]);
      await expect(page.getByRole("button", { name: "Unpin BETA", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("button", { name: /Pin No namespace/ })).toHaveCount(0);

      await page.reload();
      await expect(labels).toHaveText(["BETA", "ALPHA", "No namespace"]);
      expect(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned).toEqual(["beta"]);

      await directoryRows(page).first().click();
      await expect(page).toHaveURL(/namespace=beta/);
      await page.goBack();

      await page.getByRole("button", { name: "Unpin BETA", exact: true }).click();
      await expect(labels).toHaveText(["ALPHA", "BETA", "No namespace"]);
      expect(JSON.parse(fs.readFileSync(orderFile, "utf8"))).not.toHaveProperty("pinned");
    } finally {
      fs.rmSync(path.join(repo, "docs/plans/backlog/beta-free.md"));
    }
  });

  test("a Next up plan's namespace badge opens that namespace without opening the plan", async ({ page }) => {
    const repoScreen = `/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`;
    const badge = page.getByRole("region", { name: "Next up" }).getByRole("link", { name: "alpha", exact: true });
    const expectNamespaceOpened = async () => {
      await expect(page).toHaveURL(/namespace=alpha/);
      await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
      await expect(page.getByRole("dialog")).toHaveCount(0);
    };

    await page.goto(repoScreen);
    await badge.click();
    await expectNamespaceOpened();

    await page.goto(repoScreen);
    await badge.focus();
    await page.keyboard.press("Enter");
    await expectNamespaceOpened();
  });

  test("Next up keeps a plan waiting only on work underway, and shows what it waits on", async ({ page }) => {
    write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage", deps: ["alphaw07"] }));
    try {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      const card = page.getByRole("region", { name: "Next up" }).locator("plan-card");
      await expect(card.locator(".title-link")).toHaveText(["Storage"]);
      await expect(waitingOn(card)).toHaveText(/^\s*Working plan\s+\(Active\)\s*$/);
    } finally {
      write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage" }));
    }
  });

  test("a repo with nothing ranked shows no Next up", async ({ page }) => {
    setOrder([]);
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    await expect(directoryRows(page).first()).toBeVisible();
    await expect(page.getByRole("region", { name: "Next up" })).toHaveCount(0);
  });

  test("ranking a plan and pressing Save puts it in Next up on returning to the repo screen", async ({ page }) => {
    setOrder([]);
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const nextUp = page.getByRole("region", { name: "Next up" });
    await expect(directoryRows(page).first()).toBeVisible();
    await expect(nextUp).toHaveCount(0);

    await directoryRows(page).first().click();
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await blockFor(page, "Traces").getByRole("button", { name: "Move down" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphan04"]);
    const saved = fs.readFileSync(orderFile, "utf8");

    await page.getByRole("navigation", { name: "Backlog location" }).getByRole("link", { name: repoName }).click();
    await expect(nextUp.locator("plan-card .title-link")).toHaveText(["Traces"]);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(saved);
  });

  test("Next up shows only on a selected repo's screen", async ({ page }) => {
    const nextUp = page.getByRole("region", { name: "Next up" });
    const bareOrder = path.join(bare, "docs/plans/plans-order.json");
    // A ranked entry gives the no-config repo the one thing that could otherwise qualify it.
    fs.writeFileSync(bareOrder, JSON.stringify({ schemaVersion: 1, namespaces: { anything: ["barepl08"] } }));
    try {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      await expect(nextUp).toBeVisible();

      await page.goto("/plans?lifecycle=backlog");
      await expect(page.getByRole("link", { name: new RegExp(repoName) })).toBeVisible();
      await expect(nextUp).toHaveCount(0);

      await openNamespace(page);
      await expect(page.locator(".title-link").first()).toBeVisible();
      await expect(nextUp).toHaveCount(0);

      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, bareName)}`);
      await expect(directoryRows(page)).toContainText("No namespace");
      await expect(nextUp).toHaveCount(0);
    } finally {
      fs.rmSync(bareOrder, { force: true });
    }
  });

  test("the drawer opens another namespace's prerequisite, and Prioritize numbers blocks, not plans", async ({ page }) => {
    // Diagnostics follows the two-plan Storage block, so it is the second block but the third plan.
    write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one", deps: ["alphax03"] }));
    fs.writeFileSync(orderFile, JSON.stringify({ schemaVersion: 1, namespaces: { alpha: ["alphaa01", "alphab02", "alphax03"], beta: ["betaon05"] } }));
    try {
      await openNamespace(page, "beta");
      await page.locator("plan-card").getByText("Beta one", { exact: true }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawerHeading(page, "Beta one")).toBeVisible();
      await expect(waitingOn(drawer)).toHaveText(/^\s*alpha\s+Diagnostics\s+\(Backlog\)\s*$/);
      await drawer.getByRole("button", { name: "Diagnostics", exact: true }).click();
      await expect(drawerHeading(page, "Diagnostics")).toBeVisible();

      await openOrdering(page);
      await expect(blockFor(page, "Diagnostics").getByText("2", { exact: true })).toBeVisible();
    } finally {
      write("docs/plans/backlog/beta-one.md", document({ id: "betaon05", title: "Beta one", deps: ["alphaa01"] }));
    }
  });

  test("Home's drawer shows a prerequisite with a styled namespace badge", async ({ page }) => {
    const file = "docs/plans/active/alpha-blocked.md";
    write(file, document({ id: "alphabk9", title: "Blocked active" }).replace("depends_on: []", "blocked_by: [betaon05]\ndepends_on: []"));
    try {
      await page.goto("/");
      await page.getByRole("button", { name: "Blocked active", exact: true }).click();
      const drawer = page.getByRole("dialog");
      await expect(drawerHeading(page, "Blocked active")).toBeVisible();
      await drawer.getByRole("button", { name: "Beta one" }).first().click();
      await expect(drawerHeading(page, "Beta one")).toBeVisible();
      await expect(waitingOn(drawer)).toHaveText(/^\s*alpha\s+Storage\s+\(Backlog\)\s*$/);
      const badge = prerequisiteBadge(drawer, "alpha");
      expect(await badge.evaluate((node) => getComputedStyle(node).backgroundColor)).not.toBe("rgba(0, 0, 0, 0)");
    } finally {
      fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("a Waiting on namespace badge in Prioritize changes namespace, asking first over unsaved changes", async ({ page }) => {
    const file = "docs/plans/backlog/beta-two.md";
    const activeOnly = "docs/plans/active/gamma-running.md";
    try {
      write("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A", beta: "B", gamma: "G" } }));
      write(activeOnly, document({ id: "gammar11", title: "Running elsewhere" }));
      write(file, document({ id: "betatw10", title: "Beta two", deps: ["alphaa01", "gammar11"] }));
      await openNamespace(page, "beta");
      await page.getByRole("button", { name: "Prioritize", exact: true }).click();
      const list = waitingOn(blockFor(page, "Beta two"));
      await expect(list).toHaveText([/alpha\s+Storage\s+\(Backlog\)/, /gamma\s+Running elsewhere\s+\(Active\)/]);
      // No plan of gamma's is in Backlog, so the namespace filter has no such screen to offer.
      await expect(list.getByRole("link", { name: "gamma", exact: true })).toHaveCount(0);
      await expect(list.getByText("gamma", { exact: true })).toBeVisible();
      const badge = list.getByRole("link", { name: "alpha", exact: true });
      await expect(badge).toHaveAttribute("href", /namespace=alpha/);

      await blockFor(page, "Beta two").getByRole("button", { name: "Move down" }).first().click();
      await badge.click();
      await expect(guardDialog(page)).toBeVisible();
      await guardDialog(page).getByRole("button", { name: /save and continue/i }).click();
      await expect(page.getByRole("navigation", { name: "Backlog location" })).toContainText("ALPHA");
      expect(new URL(page.url()).searchParams.get("namespace")).toBe("alpha");
    } finally {
      write("docs/plans/plans-config.json", JSON.stringify({ schemaVersion: 1, namespaces: { alpha: "A", beta: "B" } }));
      for (const item of [file, activeOnly]) fs.rmSync(path.join(repo, item), { force: true });
    }
  });

  test("opening a Waiting on link keeps a dirty draft and its unsaved state", async ({ page }) => {
    write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage", deps: ["alphaw07"] }));
    try {
      await openOrdering(page);
      await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
      const unsaved = page.getByRole("group", { name: "Unsaved order" });
      await expect(unsaved).toBeVisible();

      await waitingOn(blockFor(page, "Storage")).getByRole("button", { name: "Working plan", exact: true }).click();
      await expect(drawerHeading(page, "Working plan")).toBeVisible();
      await expect(guardDialog(page)).toHaveCount(0);
      await page.getByRole("dialog").getByRole("button", { name: "Close" }).click();
      await expect(page.getByRole("dialog")).toHaveCount(0);

      await expect(guardDialog(page)).toHaveCount(0);
      await expect(orderedTitles(page)).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
      await expect(unsaved).toBeVisible();
      expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);
      await page.getByRole("button", { name: "Save", exact: true }).click();
      await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
      expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    } finally {
      write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage" }));
    }
  });

  test("a long unbroken title does not scroll Details, Prioritize, or the drawer sideways at phone width", async ({ page }) => {
    const unbroken = "x".repeat(89);
    write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: unbroken }));
    try {
      await page.setViewportSize({ width: 390, height: 800 });
      await openNamespace(page);
      await expect(page.getByRole("button", { name: unbroken, exact: true }).first()).toBeVisible();
      expect(await scrollsSideways(page)).toBe(false);

      await page.getByRole("button", { name: "Prioritize", exact: true }).click();
      await expect(page.locator("backlog-block").first()).toBeVisible();
      expect(await scrollsSideways(page)).toBe(false);

      await orderedTitles(page).first().click();
      await expect(drawerHeading(page, unbroken)).toBeVisible();
      expect(await scrollsSideways(page)).toBe(false);
    } finally {
      write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage" }));
    }
  });

  test.describe("a Next up card with both badges and a long title at phone width", () => {
    const LONG_TITLE = "Storage engine rewrite with a title long enough that it cannot share one line with two badges on a phone";
    test.beforeEach(() => write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: LONG_TITLE, deps: ["alphaw07"] })));
    test.afterEach(() => write("docs/plans/backlog/alpha-storage.md", document({ id: "alphaa01", title: "Storage" })));

    for (const theme of ["dark", "light"]) {
      test(`stays readable without sideways scroll in the ${theme} theme`, async ({ page }, testInfo) => {
        await page.setViewportSize({ width: 390, height: 800 });
        await page.addInitScript((value) => localStorage.setItem("portal-theme", value), theme);
        await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
        await expect(page.locator("html")).toHaveAttribute("data-theme", theme);
        const card = page.getByRole("region", { name: "Next up" }).locator("plan-card").first();
        await expect(card.getByRole("link", { name: "alpha", exact: true })).toBeVisible();
        await page.screenshot({ path: testInfo.outputPath(`next-up-${theme}.png`), fullPage: true });
        expect(await scrollsSideways(page)).toBe(false);
        expect(await card.getByRole("link", { name: "alpha", exact: true }).evaluate(contrastRatio)).toBeGreaterThanOrEqual(4.5);
        // An ellipsis would pass the overflow check above while hiding most of the title.
        const fitsInFull = (node) => node.scrollWidth <= node.clientWidth;
        expect(await card.getByText(LONG_TITLE, { exact: true }).evaluate(fitsInFull)).toBe(true);
        const noNamespaceLabel = directoryRows(page).filter({ hasText: "No namespace" }).getByText("No namespace", { exact: true });
        expect((await noNamespaceLabel.boundingBox()).height).toBeLessThan(30);
      });
    }
  });

  test("moves stay in the draft until Save, and focus follows the moved block", async ({ page }) => {
    await openOrdering(page);
    const before = fs.readFileSync(orderFile, "utf8");
    await blockFor(page, "Traces").getByRole("button", { name: "Move down" }).click();
    await expect(page.getByRole("heading", { name: /^Needs prioritization/ })).toHaveCount(0);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move up" }).focus();
    await page.keyboard.press("Enter");
    await expect(blockFor(page, "Diagnostics").getByRole("button", { name: "Move up" })).toBeFocused();
    await expect(orderedTitles(page)).toHaveText(["Traces", "Diagnostics", "Storage", "Retrieval"]);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);

    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphan04", "alphax03", "alphaa01", "alphab02"]);
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".title-link")).toHaveText(["Traces", "Diagnostics", "Storage", "Retrieval"]);
    await expect(page.getByRole("dialog", { name: GUARD })).toHaveCount(0);
  });

  test("Cancel discards at once, with no confirmation", async ({ page }) => {
    await openOrdering(page);
    const before = fs.readFileSync(orderFile, "utf8");
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByRole("dialog")).toHaveCount(0);
    await expect(orderedTitles(page).first()).toHaveText("Storage");
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);
  });

  test("Discard Changes leaves a dirty draft without saving, and goes where the user was headed", async ({ page }) => {
    await openOrdering(page);
    const before = fs.readFileSync(orderFile, "utf8");
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    // Stacked, with the save first.
    const choices = guardDialog(page).getByRole("button");
    await expect(choices).toHaveText(["Save and Continue", "Discard Changes", "Keep Editing"]);
    const boxes = await choices.evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect()).map(({ x, width, top }) => ({ x, width, top })));
    expect(boxes[0].top).toBeLessThan(boxes[1].top);
    expect(boxes[1].top).toBeLessThan(boxes[2].top);
    expect(new Set(boxes.map(({ x, width }) => `${x}:${width}`)).size).toBe(1);
    await guardDialog(page).getByRole("button", { name: "Discard Changes", exact: true }).click();
    await expect(guardDialog(page)).toBeHidden();
    await expect(page).toHaveURL(/lifecycle=active/);
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);

    // Coming back finds the committed order, in Details, with nothing left to guard.
    await openNamespace(page);
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await guardDialog(page).getByRole("button", { name: "Discard Changes", exact: true }).click();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(page.locator(".title-link").first()).toHaveText("Storage");
    expect(fs.readFileSync(orderFile, "utf8")).toBe(before);
  });

  test("dragging a block moves it among the blocks, as a draft", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("img", { name: "Drag to move" }).dragTo(blockFor(page, "Storage"), { targetPosition: { x: 40, y: 2 } });
    await expect(orderedTitles(page)).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
    await blockFor(page, "Traces").getByRole("img", { name: "Drag to move" }).dragTo(blockFor(page, "Diagnostics"), { targetPosition: { x: 40, y: 2 } });
    await expect(orderedTitles(page).first()).toHaveText("Traces");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);
  });

  test("leaving a dirty draft asks first: Keep Editing stays, Save and Continue saves and goes", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    const makeDirtyAgain = async () => {
      await page.getByRole("button", { name: "Prioritize", exact: true }).click();
      await blockFor(page, "Traces").getByRole("button", { name: "Move to bottom" }).click();
    };

    // Details toggle.
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeVisible();
    expect(savedOrder()).toEqual(["alphaa01", "alphab02", "alphax03"]);
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(guardDialog(page)).toBeHidden();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);

    // Lifecycle tab.
    await makeDirtyAgain();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page).toHaveURL(/lifecycle=backlog/);

    // Breadcrumb.
    await page.getByRole("navigation", { name: "Backlog location" }).getByRole("link", { name: "All repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page).toHaveURL(/namespace=alpha/);

    // Header link to another portal page.
    await page.getByRole("navigation", { name: "Portal sections" }).getByRole("link", { name: "Repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page).toHaveURL(/\/plans/);

    // Lifecycle tab again, this time saving: the save happens, then the move.
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(page).toHaveURL(/lifecycle=active/);
    await expect(page).not.toHaveURL(/namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02", "alphan04"]);
  });

  test("back/forward cannot be cancelled, so a dirty draft restores the URL and asks", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    await directoryRows(page).first().click();
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.goBack();
    await expect(guardDialog(page)).toBeVisible();
    await expect(page).toHaveURL(/namespace=alpha/);
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
    await page.goBack();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(page).not.toHaveURL(/namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("the repo selector holds its change while a draft is dirty", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    const selector = page.locator("#repository-scope option-dropdown");
    await selector.getByRole("button").first().click();
    await page.getByRole("option", { name: "All repos" }).click();
    await expect(guardDialog(page)).toBeVisible();
    await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
    await expect(page).toHaveURL(/namespace=alpha/);
    await expect(selector).toContainText(repoName);
  });

  test("closing the tab with a dirty draft raises the browser's own prompt", async ({ page }) => {
    const tab = await page.context().newPage();
    await enablePlanBoard(tab);
    await openOrdering(tab);
    await blockFor(tab, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
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
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    setOrder(["alphax03", "alphan04", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
    await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(orderedTitles(page)).toHaveText(["Diagnostics", "Traces", "Storage", "Retrieval"]);
  });

  test("a save the server refuses keeps the draft and says why", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
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
    await expect(orderedTitles(page)).toHaveText(["Storage", "Retrieval", "Diagnostics"]);
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
      await expect(row("No namespace")).toContainText("1 total");

      writeNamespaces({ alpha: "A", beta: "B", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("WRONG")).toContainText("1 total");
      await expect(row("No namespace")).toHaveCount(0);

      writeNamespaces({ alpha: "A", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("BETA")).toHaveCount(0);
      await expect(row("No namespace")).toContainText("Repair needed");

      writeNamespaces({ alpha: "A", gamma: "was beta", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(row("GAMMA")).toHaveCount(0);
      await expect(row("No namespace")).toContainText("Repair needed");
    });

    test("a config edit reaches a reloaded page with no Refresh", async ({ page }) => {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      await expect(directoryRows(page).filter({ hasText: "No namespace" })).toContainText("1 total");
      writeNamespaces({ alpha: "A", beta: "B", wrong: "W" });
      await page.reload();
      await expect(directoryRows(page).filter({ hasText: "WRONG" })).toContainText("1 total");
      await expect(directoryRows(page).filter({ hasText: "No namespace" })).toHaveCount(0);
    });

    test("an unreadable config is an error, and no plan disappears", async ({ page }) => {
      await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
      fs.writeFileSync(config, "{ nope");
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByText("docs/plans/plans-config.json cannot be read")).toBeVisible();
      await expect(directoryRows(page)).toHaveCount(1);
      await expect(directoryRows(page)).toContainText("6 total");
    });

    test("a dirty draft cannot save across a conflicting config edit", async ({ page }) => {
      await openOrdering(page);
      await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
      writeNamespaces({ alpha: "A", beta: "B", wrong: "W" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
      await expect(page.getByRole("button", { name: "Save", exact: true })).toBeDisabled();
    });

    test("a dirty draft survives its namespace being removed, stale and still guarded", async ({ page }) => {
      await openOrdering(page);
      await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
      const held = fs.readFileSync(orderFile, "utf8");
      writeNamespaces({ beta: "B" });
      await page.getByRole("button", { name: "Refresh", exact: true }).click();
      await expect(page.getByRole("group", { name: "Unsaved order" }).getByRole("status")).toContainText("changed elsewhere");
      await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
      await page.getByRole("button", { name: /^Active \(/ }).click();
      await expect(guardDialog(page)).toBeVisible();
      await expect(guardDialog(page).getByRole("button", { name: "Save and Continue" })).toBeDisabled();
      await expect(guardDialog(page).getByRole("button", { name: "Keep Editing" })).toBeFocused();
      await guardDialog(page).getByRole("button", { name: "Keep Editing" }).click();
      await page.getByRole("button", { name: "Cancel", exact: true }).click();
      await expect(directoryRows(page).filter({ hasText: "No namespace" })).toBeVisible();
      expect(fs.readFileSync(orderFile, "utf8")).toBe(held);
    });
  });

  test("the Save bar stays on screen while a long list scrolls", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 420 });
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.evaluate(() => window.scrollTo(0, 0));
    await expect(blockFor(page, "Retrieval")).not.toBeInViewport();
    const bar = page.getByRole("group", { name: "Unsaved order" });
    await expect(bar).toBeInViewport({ ratio: 1 });
    await blockFor(page, "Retrieval").scrollIntoViewIfNeeded();
    await expect(bar).toBeInViewport({ ratio: 1 });
  });

  test("a double click on Save sends one save and leaves the page working", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
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

  test("the prioritize banner counts plans, not blocks, and the Prioritize heading has no count", async ({ page }) => {
    setOrder([]);
    await openNamespace(page);
    await expect(page.locator("backlog-block")).toHaveCount(3);
    await expect(page.getByRole("heading", { name: /^Needs prioritization/ })).toHaveText("Needs prioritization");
    await page.getByRole("button", { name: "Details", exact: true }).click();
    await expect(page.locator(".backlog-prioritize-banner")).toContainText("4 new plans need prioritization");
  });

  test("a plan with a duplicate id is shown with its reason and no controls", async ({ page }) => {
    const copies = ["docs/plans/backlog/alpha-twin-one.md", "docs/plans/backlog/alpha-twin-two.md"];
    try {
      for (const [index, file] of copies.entries()) write(file, document({ id: "twinplan", title: `Twin ${index}`, deps: ["alphax03"] }));
      await openOrdering(page);
      await expect(page.getByText("Duplicate id: twinplan")).toHaveCount(2);
      await expect(page.locator("backlog-block", { hasText: "Twin" })).toHaveCount(0);
      await expect(page.getByRole("list", { name: "Waiting on", exact: true }).filter({ hasText: "Diagnostics" })).toHaveCount(2);
    } finally {
      for (const file of copies) fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("an unparseable order file locks Prioritize and says why, and is left alone", async ({ page }) => {
    fs.writeFileSync(orderFile, "{ nope");
    await openOrdering(page);
    await expect(page.getByText("docs/plans/plans-order.json cannot be read")).toBeVisible();
    await expect(page.getByRole("button", { name: "Move to bottom" })).toHaveCount(0);
    await expect(page.locator("backlog-block").first()).toContainText("blocked");
    expect(fs.readFileSync(orderFile, "utf8")).toBe("{ nope");
  });

  // Delays the snapshot refresh a Save or Cancel ends with. Falls back so the plan board stays enabled.
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
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    await expect(orderedTitles(page)).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
    const moveDown = blockFor(page, "Diagnostics").getByRole("button", { name: "Move down" });
    await expect(moveDown).toBeDisabled();
    await expect(blockFor(page, "Diagnostics").getByRole("img", { name: "Drag to move" })).toHaveAttribute("draggable", "false");
    release();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".title-link")).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
    expect(errors).toEqual([]);
  });

  test("a Save whose refresh fails keeps the saved order on screen and says the page is out of date", async ({ page }) => {
    await openOrdering(page);
    const failing = /\/api\/plans\/refresh/;
    await page.route(failing, (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "refresh broke" }) }));
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByText("Your order was saved.")).toBeVisible();
    await expect(page.getByText(/may be out of date/)).toBeVisible();
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prioritize", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(orderedTitles(page)).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
    await expect(blockFor(page, "Diagnostics").getByRole("button", { name: "Move down" })).toBeDisabled();

    await page.unroute(failing);
    await page.getByRole("button", { name: "Refresh", exact: true }).click();
    await expect(page.getByRole("button", { name: "Details", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(page.locator(".title-link")).toHaveText(["Diagnostics", "Storage", "Retrieval"]);
    await expect(page.getByText(/may be out of date/)).toHaveCount(0);
  });

  test("a failed pin says why and leaves the button ready to retry", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, repoName)}`);
    const pin = page.getByRole("button", { name: "Pin ALPHA", exact: true });
    await page.route("**/api/plans/namespace-pin", (route) => route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "pin broke" }) }));
    await pin.click();
    await expect(page.getByText(/pin broke/)).toBeVisible();
    await expect(pin).toBeEnabled();
    expect(JSON.parse(fs.readFileSync(orderFile, "utf8"))).not.toHaveProperty("pinned");

    await page.unroute("**/api/plans/namespace-pin");
    await pin.click();
    await expect(page.getByRole("button", { name: "Unpin ALPHA", exact: true })).toBeVisible();
    expect(JSON.parse(fs.readFileSync(orderFile, "utf8")).pinned).toEqual(["alpha"]);
  });

  test("after a Cancel, the committed order is live before the refresh returns", async ({ page }) => {
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    await openOrdering(page);
    const release = await holdRefresh(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Cancel", exact: true }).click();
    await expect(page.getByText("Unsaved changes")).toHaveCount(0);
    await expect(orderedTitles(page).first()).toHaveText("Storage");
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
    release();
    await expect(page.getByRole("button", { name: "Refresh", exact: true })).toBeEnabled();
    await expect(page.getByText("Unsaved changes")).toBeVisible();
    await expect(orderedTitles(page).first()).toHaveText("Diagnostics");
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
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
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
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    setOrder(["alphax03", "alphaa01", "alphab02"]);
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(guardDialog(page).getByRole("alert")).toContainText("changed since you opened Prioritize");
    await expect(guardDialog(page).getByRole("button", { name: "Save and Continue" })).toBeDisabled();
    await expect(page).toHaveURL(/lifecycle=backlog.*namespace=alpha/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("Save and Continue from the repo selector saves, then changes the repo", async ({ page }) => {
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.locator("#repository-scope option-dropdown").getByRole("button").first().click();
    await page.getByRole("option", { name: "All repos" }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(page).not.toHaveURL(/repo=|namespace=/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
    await expect(page.getByRole("link", { name: new RegExp(repoName) })).toBeVisible();
  });

  test("a breadcrumb leaves a dirty draft in place, keeping filters and the page", async ({ page }) => {
    await openNamespace(page);
    await page.getByRole("button", { name: "Filters", exact: true }).click();
    await page.getByRole("searchbox").fill("Retrieval");
    await page.getByRole("button", { name: "Update", exact: true }).click();
    await page.getByRole("button", { name: "Prioritize", exact: true }).click();
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.evaluate(() => { window.samePage = true; });
    await page.getByRole("navigation", { name: "Backlog location" }).getByRole("link", { name: repoName }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
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
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: "Save", exact: true }).click();
    await expect(page.getByRole("button", { name: "Cancel", exact: true })).toBeDisabled();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await expect(guardDialog(page)).toBeHidden();
    release();
    await expect(page).toHaveURL(/lifecycle=active/);
    expect(savedOrder()).toEqual(["alphax03", "alphaa01", "alphab02"]);
  });

  test("a Save the filesystem refuses reports the code and no absolute path", async ({ page }) => {
    test.skip(process.getuid?.() === 0, "root ignores the read-only folder");
    const plansFolder = path.dirname(orderFile);
    const held = fs.readFileSync(orderFile, "utf8");
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    fs.chmodSync(plansFolder, 0o555);
    try {
      await page.getByRole("button", { name: "Save", exact: true }).click();
      const status = page.getByRole("group", { name: "Unsaved order" }).getByRole("status");
      await expect(status).toContainText("docs/plans/plans-order.json could not be written (EACCES).");
      await expect(status).not.toContainText(repo);
      expect(fs.readFileSync(orderFile, "utf8")).toBe(held);
    } finally {
      fs.chmodSync(plansFolder, 0o755);
    }
  });

  test("the guard's Cancel waits for its Save, which then decides the move", async ({ page }) => {
    let release;
    const held = new Promise((resolve) => { release = resolve; });
    await page.route("**/api/plans/order", async (route) => {
      await held;
      await route.continue();
    });
    await openOrdering(page);
    await blockFor(page, "Diagnostics").getByRole("button", { name: "Move to top" }).click();
    await page.getByRole("button", { name: /^Active \(/ }).click();
    await guardDialog(page).getByRole("button", { name: "Save and Continue" }).click();
    await expect(guardDialog(page).getByRole("button", { name: "Keep Editing" })).toBeDisabled();
    await page.keyboard.press("Escape");
    await expect(guardDialog(page)).toBeVisible();
    release();
    await expect(page).toHaveURL(/lifecycle=active/);
  });

  test("a cancelled drag does not leave its block armed", async ({ page }) => {
    await openOrdering(page);
    const before = await orderedTitles(page).allTextContents();
    await blockFor(page, "Diagnostics").getByRole("img", { name: "Drag to move" }).dispatchEvent("dragstart", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()) });
    await blockFor(page, "Diagnostics").getByRole("img", { name: "Drag to move" }).dispatchEvent("dragend");
    await orderedList(page).dispatchEvent("drop", { dataTransfer: await page.evaluateHandle(() => new DataTransfer()), clientY: 0 });
    await expect(orderedTitles(page)).toHaveText(before);
    await expect(page.getByRole("button", { name: "Save", exact: true })).toHaveCount(0);
  });

  test("No namespace lists the exact filename and how to repair it, with no ordering", async ({ page }) => {
    await openNamespace(page, "_none");
    await expect(page.getByText("wrong-prefix.md")).toBeVisible();
    await expect(page.getByText("Unknown plan namespace: wrong.")).toBeVisible();
    await expect(page.getByRole("button", { name: "Prioritize", exact: true })).toHaveCount(0);
  });

  test("No namespace keeps a long filename readable at phone width", async ({ page }) => {
    const stem = "x".repeat(96);
    const file = `docs/plans/backlog/${stem}.md`;
    write(file, document({ id: "longname", title: "Long filename plan" }));
    try {
      await page.setViewportSize({ width: 390, height: 800 });
      await openNamespace(page, "_none");
      const filename = page.getByText(`${stem}.md`, { exact: true });
      await expect(filename).toBeVisible();
      // The row clips what overflows, so the page never scrolls and only the text's own edge shows it.
      const rights = await page.getByText(stem).evaluateAll((nodes) => nodes.map((node) => node.getBoundingClientRect().right));
      expect(Math.max(...rights)).toBeLessThanOrEqual(390);
    } finally {
      fs.rmSync(path.join(repo, file), { force: true });
    }
  });

  test("Copy Repair Prompt copies a /plan-write prompt naming the misfiled plan", async ({ page }) => {
    await page.context().grantPermissions(["clipboard-read", "clipboard-write"]);
    await openNamespace(page, "_none");
    await page.getByRole("button", { name: "Copy Repair Prompt" }).click();
    await expect(page.getByText("Copied the /plan-write prompt.")).toBeVisible();
    const copied = await page.evaluate(() => navigator.clipboard.readText());
    expect(copied).toContain("/plan-write");
    expect(copied).toContain("docs/plans/backlog/wrong-prefix.md");
  });

  test("a repo with no config shows one No namespace row and a notice, no per-file findings", async ({ page }) => {
    await page.goto(`/plans?lifecycle=backlog&repo=${await repoKey(page, bareName)}`);
    const notice = page.locator("portal-notice", { hasText: "/plan-suite-init" });
    await expect(notice).toContainText("Run the /plan-suite-init skill to declare them.");
    await expect(notice).toHaveClass(/notice-warning/);
    await expect(notice).toContainText("Namespaces are the categories");
    await expect(notice).toContainText("All repos have default namespaces available once set up, including cli, git, docs, and security.");
    // The icon sits level with the first line of text, however many lines there are.
    const firstLineCenter = await notice.locator("p").first().evaluate((node) => {
      const range = globalThis.document.createRange();
      range.selectNodeContents(node);
      const line = range.getClientRects()[0];
      return line.top + line.height / 2;
    });
    const icon = await notice.locator("svg").boundingBox();
    expect(Math.abs(icon.y + icon.height / 2 - firstLineCenter)).toBeLessThanOrEqual(2);
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
      await page.getByRole("button", { name: "Prioritize", exact: true }).click();
      await expect(page.getByText("alphax03 depends on missing9, which does not exist.")).toBeVisible();
      await expect(page.getByRole("button", { name: "Move to top" })).toHaveCount(0);
      await expect(page.locator("backlog-block", { hasText: "Storage" })).toContainText("blocked");
    } finally {
      write(file, document({ id: "alphax03", title: "Diagnostics" }));
    }
  });

  test("other lifecycle tabs keep their flat cards, with no namespace badge or ordering", async ({ page }) => {
    await page.goto(`/plans?lifecycle=active&repo=${await repoKey(page, repoName)}`);
    await expect(page.locator(".title-link")).toHaveText(["Working plan"]);
    await expect(page.getByRole("link", { name: "alpha", exact: true })).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Prioritize", exact: true })).toHaveCount(0);
    await expect(directoryRows(page)).toHaveCount(0);
    await expect(page.getByRole("button", { name: "Filters", exact: true })).toBeVisible();
  });
});
