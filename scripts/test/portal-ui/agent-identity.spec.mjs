// The GitHub bot identity on Home: the status line at a GitHub repo card's foot, the card behind it,
// **Open setup** (which only asks the server to open the terminal setup), the copy-command fallback,
// and the refresh when the user comes back. The server side is covered by
// repository-agent-identity-check.mjs, so these tests answer its routes with fixed reports.
import { test, expect } from "@playwright/test";
import { createPlanFixture } from "../lib/plan-git-fixture.mjs";
import { addRepositorySource, removeFixtureContents, removeRepositorySources, roboRepoCard } from "./helpers.mjs";

const REPO = "example/identity-suite";
const SETUP_FIX = "Run roborepo github setup in your own terminal.";
const guide = {
  command: "roborepo github setup",
  links: [
    { label: "Create the bot account", url: "https://github.com/signup", note: "In a private window." },
    { label: "New classic token", url: "https://github.com/settings/tokens/new", note: "Scopes repo and read:org only." },
  ],
  expiry: "90 days is a good default.",
  tokenWarning: "Paste the token only at the setup's hidden prompt in your terminal, never into the portal or an agent chat.",
};
const report = (overrides = {}) => ({
  applies: true, state: "healthy", repository: REPO, botLogin: "robo-bot", packageEnabled: true, expiresAt: null, reason: null,
  findings: [], setupLaunch: { supported: true }, guide, ...overrides,
});
const finding = (id, severity, message, fix = SETUP_FIX) => ({ id, severity, message, fix });

test.describe("Agent GitHub account", () => {
  let fx;
  let checkout;

  test.beforeAll(() => {
    fx = createPlanFixture("portal-ui-agent-identity-");
    checkout = fx.repository("identity-suite", { "README.md": "fixture\n" });
    const bare = fx.git(checkout, "remote", "get-url", "origin");
    fx.git(checkout, "config", `url.${bare}.insteadOf`, `git@github.com:${REPO}.git`);
    fx.git(checkout, "remote", "set-url", "origin", `git@github.com:${REPO}.git`);
  });
  test.afterAll(() => removeFixtureContents(fx));
  test.beforeEach(async ({ page }) => addRepositorySource(page, checkout));
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  // Answers the status route for every repo with `next()` (so a test can change the answer between
  // reads), records each read's repo and freshness, and answers the setup route with `launch`.
  async function stubIdentity(page, { next, launch = { launched: true } }) {
    const reads = [];
    const posts = [];
    await page.route(/\/api\/repositories\/[^/]+\/agent-identity(\/setup)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const repositoryId = decodeURIComponent(url.pathname.split("/")[3]);
      if (route.request().method() === "POST") {
        posts.push({ repositoryId, body: route.request().postData() });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(launch) });
      }
      reads.push({ repositoryId, fresh: url.searchParams.get("fresh") === "1" });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ repositoryId, ...next(repositoryId) }) });
    });
    return { reads, posts };
  }

  const suiteCard = (page) => page.locator(".repository-card").filter({ has: page.getByRole("heading", { name: "identity-suite", exact: true }) });
  const line = (page) => suiteCard(page).locator(".agent-identity-line");
  const card = (page) => page.getByRole("dialog", { name: "Agent GitHub account" });
  const openHome = async (page) => {
    await page.goto("/");
    await expect(suiteCard(page)).toBeVisible();
  };

  test("not set up: the line says so and the card offers Open setup and the github.com steps", async ({ page }) => {
    await stubIdentity(page, { next: () => report({ state: "not-set-up", botLogin: null, packageEnabled: false }) });
    await openHome(page);
    await expect(line(page).locator("[data-slot=state]")).toHaveText("not set up");
    await line(page).getByRole("button", { name: "Details" }).click();
    await expect(card(page)).toContainText("Agents act on GitHub as you.");
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    await card(page).getByText("What you do on github.com").click();
    await expect(card(page).getByRole("link", { name: "New classic token" })).toHaveAttribute("href", "https://github.com/settings/tokens/new");
    await expect(card(page)).toContainText(guide.tokenWarning);
  });

  test("healthy, renew soon, and a problem the setup cannot fix", async ({ page }) => {
    let answer = report();
    await stubIdentity(page, { next: () => answer });
    await openHome(page);
    await expect(line(page).locator("[data-slot=state]")).toHaveText("healthy");
    await suiteCard(page).getByRole("button", { name: "Actions", exact: true }).click();
    await suiteCard(page).getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(card(page)).toContainText("Agents act as robo-bot.");
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
    await card(page).getByRole("button", { name: "Close" }).click();

    answer = report({ expiresAt: "2099-01-01T00:00:00.000Z", findings: [finding("expiring", "warn", "The bot's token expires in 5 days.")] });
    await line(page).getByRole("button", { name: "Details" }).click();
    await card(page).getByRole("button", { name: "Check again" }).click();
    await expect(card(page).locator("[data-slot=state]")).toHaveText("renew soon");
    await expect(card(page)).toContainText(`Fix: ${SETUP_FIX}`);
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    await expect(line(page)).toContainText("The bot's token expires in 5 days.");
    await card(page).getByRole("button", { name: "Close" }).click();

    answer = report({ state: "problem", findings: [finding("bot-is-admin", "problem", "robo-bot is an admin of example/identity-suite.", "Lower robo-bot to write access, then rerun roborepo github status.")] });
    await line(page).getByRole("button", { name: "Details" }).click();
    await card(page).getByRole("button", { name: "Check again" }).click();
    await expect(card(page).locator("[data-slot=state]")).toHaveText("needs attention");
    await expect(card(page)).toContainText("Fix: Lower robo-bot to write access");
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
  });

  test("unavailable shows its reason; a repo the server turns down shows no line", async ({ page }) => {
    await stubIdentity(page, { next: () => report({ state: "unavailable", reason: "GitHub did not answer" }) });
    await openHome(page);
    await expect(line(page).locator("[data-slot=state]")).toHaveText("not checked");
    await expect(line(page)).toContainText("The status could not be checked: GitHub did not answer.");
    await page.unroute(/agent-identity/);
    await stubIdentity(page, { next: () => ({ applies: false }) });
    await openHome(page);
    await expect(suiteCard(page)).toBeVisible();
    await expect(line(page)).toBeHidden();
  });

  test("Open setup posts no body, and coming back re-reads only that repo", async ({ page }) => {
    let answer = report({ state: "not-set-up", botLogin: null });
    const { reads, posts } = await stubIdentity(page, { next: () => answer });
    await openHome(page);
    await line(page).getByRole("button", { name: "Details" }).click();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("A terminal opened running roborepo github setup in this repo's folder.");
    expect(posts.length).toBe(1);
    expect(posts[0].repositoryId).toBe(`git:github.com/${REPO}`);
    expect(JSON.parse(posts[0].body || "{}")).toEqual({});

    answer = report();
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card(page).locator("[data-slot=state]")).toHaveText("healthy");
    await expect(line(page).locator("[data-slot=state]")).toHaveText("healthy");
    expect(reads.filter((read) => read.fresh)).toEqual([{ repositoryId: `git:github.com/${REPO}`, fresh: true }]);
  });

  test("where the button cannot open a terminal, the card shows the command to copy", async ({ page }) => {
    await stubIdentity(page, { next: () => report({ state: "not-set-up", botLogin: null, setupLaunch: { supported: false } }) });
    await openHome(page);
    await line(page).getByRole("button", { name: "Details" }).click();
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
    await expect(card(page).locator("portal-copy-button")).toBeVisible();
  });

  test("a failed launch falls back to the command to copy", async ({ page }) => {
    await stubIdentity(page, {
      next: () => report({ state: "not-set-up", botLogin: null }),
      launch: { launched: false, reason: "launch_failed", error: "open exited 1" },
    });
    await openHome(page);
    await line(page).getByRole("button", { name: "Details" }).click();
    await expect(card(page).locator("[data-slot=command-row]")).toBeHidden();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("The terminal did not open. Run the command below in your own terminal instead.");
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
  });
});
