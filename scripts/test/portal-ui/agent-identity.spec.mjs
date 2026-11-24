// The GitHub bot identity on Home: the bot account's banner (shown once, above the repo list), each
// GitHub repo card's line (what is about that repo only), the card behind both, **Turn on** (only
// when the package is the one step left), **Open setup** (which only asks the server to open the
// terminal setup), the copy-command fallback, the github.com steps (addresses to copy into the bot's
// browser, done steps dimmed), and the refresh when the user comes back. Every account state and
// every repo state is rendered here. The server side is covered by repository-agent-identity-check.mjs,
// so these tests answer its routes with fixed reports.
//
// AGENT_IDENTITY_SHOTS=<folder> also saves a screenshot of each state there, for a person to look at.
import fs from "node:fs";
import path from "node:path";
import { test, expect } from "@playwright/test";
import { setupGuide } from "../../../modules/forge/agent-identity-guide.mjs";
import { ownerMessage } from "../../../modules/forge/agent-identity.mjs";
import { createPlanFixture } from "../lib/plan-git-fixture.mjs";
import { addRepositorySource, removeFixtureContents, removeRepositorySources } from "./helpers.mjs";

const SHOTS = process.env.AGENT_IDENTITY_SHOTS || null;
const SETUP_FIX = "Run roborepo github setup in your own terminal.";
const guide = setupGuide();
const BOT = "robo-bot";
const finding = (id, severity, message, fix = SETUP_FIX, owner = false) => ({ id, severity, message, fix, owner });

const account = (overrides = {}) => ({
  state: "healthy", botLogin: BOT, savedLogin: BOT, signedIn: true, packageEnabled: true,
  expiresAt: "2027-02-20T12:00:00.000Z", scopes: ["repo", "read:org"], reason: null, findings: [],
  enableOffered: false, setupLaunch: { supported: true }, guide, ...overrides,
});

// Every account state the banner can show. `ready` says whether repos get their own line.
const ACCOUNTS = {
  "not-set-up": {
    ready: false, label: "not set up",
    report: account({ state: "not-set-up", botLogin: null, savedLogin: null, signedIn: false, packageEnabled: false, expiresAt: null, scopes: null }),
  },
  "package-off": {
    ready: true, label: "off",
    report: account({
      state: "problem", packageEnabled: false, enableOffered: true,
      findings: [finding("package-off", "problem", "The bot is signed in, but the github-agent-identity package is off, so agents still act as you.", "Turn it on: roborepo package enable github-agent-identity.")],
    }),
  },
  healthy: { ready: true, label: "on", report: account() },
  "renew-soon": {
    ready: true, label: "renew soon",
    report: account({ expiresAt: "2026-11-29T12:00:00.000Z", findings: [finding("expiring", "warn", "The bot's token expires in 5 days.")] }),
  },
  "token-expired": {
    ready: false, label: "token expired",
    report: account({ state: "problem", botLogin: null, expiresAt: null, scopes: null, findings: [finding("expired", "problem", "GitHub rejected the bot's token (it expired or was revoked).")] }),
  },
  "needs-attention": {
    ready: true, label: "needs attention",
    report: account({
      state: "problem", scopes: ["repo", "read:org", "workflow"],
      findings: [finding("broad-scopes", "problem", "The bot's token has broader access than agents need (workflow).", "Make a new token with only the repo and read:org scopes, then run roborepo github setup in your own terminal.")],
    }),
  },
  "not-checked": {
    ready: false, label: "not checked",
    report: account({ state: "unavailable", botLogin: null, expiresAt: null, scopes: null, reason: "GitHub could not be reached" }),
  },
};

const repoReport = (name, state, findings = [], overrides = {}) => ({
  applies: true, account: "ready", state, repository: `example/${name}`, botLogin: BOT, userAdmin: true, reason: null,
  findings, ownerMessage: null, setupLaunch: { supported: true }, ...overrides,
});

// Every repo state a card's line can show, each on its own repo.
const REPOS = {
  "identity-ready": { label: "ready", report: (name) => repoReport(name, "healthy") },
  "identity-invited": {
    label: "invite pending",
    report: (name) => repoReport(name, "problem", [finding("invite-pending", "problem", `${BOT} has been invited to example/${name} but has not accepted yet.`, "Run roborepo github setup in this repo, in your own terminal; it accepts the invitation as the bot.")]),
  },
  "identity-uninvited": {
    label: "not invited",
    report: (name) => repoReport(name, "problem", [finding("not-collaborator", "problem", `${BOT} cannot push to example/${name}.`, "Run roborepo github setup in this repo, in your own terminal; it sends the invitation.")]),
  },
  "identity-theirs": {
    label: "not invited",
    report: (name) => repoReport(name, "problem", [
      finding("not-collaborator", "problem", `${BOT} is not a collaborator on example/${name}, and you are not an admin there, so setup cannot invite it.`, `Ask the repo's owner to invite ${BOT} with Write access; Home and roborepo github status give you a message to send them.`, true),
      finding("protection", "problem", "Branch protection for this repo is missing, so GitHub does not stop the bot from merging unreviewed work.", "Ask the repo's owner to add the branch rules; Home and roborepo github status give you a message to send them.", true),
    ], { userAdmin: false, ownerMessage: ownerMessage({ repo: `example/${name}`, botLogin: BOT }) }),
  },
  "identity-unverified": {
    label: "rules unverified",
    report: (name) => repoReport(name, "unverified", [
      finding("protection-unverified", "unverified", "GitHub applies the branch rules, but you are not an admin of this repo, so RoboRepo cannot see who may bypass them.", "Ask the repo's owner to confirm them, and that the bot cannot bypass them; Home and roborepo github status give you a message to send them.", true),
    ], { userAdmin: false, ownerMessage: ownerMessage({ repo: `example/${name}`, botLogin: BOT, invite: false }) }),
  },
  "identity-unprotected": {
    label: "branch rules missing",
    report: (name) => repoReport(name, "problem", [finding("protection", "problem", "Branch protection for this repo is missing, so GitHub does not stop the bot from merging unreviewed work.", "Run roborepo protect in this repo (it asks before changing anything), or open Branch protection in the repo's menu on Home.")]),
  },
  "identity-bot-admin": {
    label: "too much access",
    report: (name) => repoReport(name, "problem", [finding("bot-is-admin", "problem", `${BOT} is an admin of example/${name}, so it could change the branch protection meant to limit it.`, `Lower ${BOT} to write access in the repo's collaborator settings, then rerun roborepo github status.`)]),
  },
  "identity-unread": {
    label: "not checked",
    report: (name) => repoReport(name, "unavailable", [], { reason: "GitHub did not answer" }),
  },
};
const NAMES = Object.keys(REPOS);

async function shot(target, name) {
  if (!SHOTS) return;
  fs.mkdirSync(SHOTS, { recursive: true });
  await target.screenshot({ path: path.join(SHOTS, `${name}.png`), ...(target.goto ? { fullPage: true } : {}) });
}

test.describe("Agent GitHub account", () => {
  // Taller pages for the screenshots, so a card is not cut off at the fold.
  if (SHOTS) test.use({ viewport: { width: 1280, height: 1500 } });
  let fx;
  const checkouts = [];

  test.beforeAll(() => {
    fx = createPlanFixture("portal-ui-agent-identity-");
    for (const name of NAMES) {
      const checkout = fx.repository(name, { "README.md": "fixture\n" });
      const bare = fx.git(checkout, "remote", "get-url", "origin");
      fx.git(checkout, "config", `url.${bare}.insteadOf`, `git@github.com:example/${name}.git`);
      fx.git(checkout, "remote", "set-url", "origin", `git@github.com:example/${name}.git`);
      checkouts.push(checkout);
    }
  });
  test.afterAll(() => removeFixtureContents(fx));
  test.beforeEach(async ({ page }) => {
    for (const checkout of checkouts) await addRepositorySource(page, checkout);
  });
  test.afterEach(async ({ page }) => removeRepositorySources(page));

  // Answers the account route with `accountNext()`, each repo route with `repoNext(name)` (or
  // "waiting" while the account cannot be used), the setup route with `launch`, and the enable route
  // with `enable()`. Records each read and post.
  async function stub(page, { accountNext, repoNext = (name) => REPOS[name].report(name), ready = () => true, launch = { launched: true }, enable = null }) {
    const reads = [];
    const posts = [];
    await page.route(/\/api\/agent-identity(\/enable)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST") {
        posts.push({ kind: "enable", body: route.request().postData() });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(enable()) });
      }
      reads.push({ kind: "account", fresh: url.searchParams.get("fresh") === "1" });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(accountNext()) });
    });
    await page.route(/\/api\/repositories\/[^/]+\/agent-identity(\/setup)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const repositoryId = decodeURIComponent(url.pathname.split("/")[3]);
      const name = repositoryId.split("/").pop();
      if (route.request().method() === "POST") {
        posts.push({ kind: "setup", repositoryId, body: route.request().postData() });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(launch) });
      }
      reads.push({ kind: "repo", name, fresh: url.searchParams.get("fresh") === "1" });
      const body = !REPOS[name] ? { applies: false }
        : ready() ? repoNext(name) : { applies: true, account: "waiting", state: null, findings: [], setupLaunch: { supported: true } };
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ repositoryId, ...body }) });
    });
    return { reads, posts };
  }

  const banner = (page) => page.locator(".agent-identity-banner");
  const repoCard = (page, name) => page.locator(".repository-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const line = (page, name) => repoCard(page, name).locator(".agent-identity-line");
  const card = (page) => page.getByRole("dialog", { name: "Agent GitHub account" });
  const openHome = async (page) => {
    await page.goto("/");
    for (const name of NAMES) await expect(repoCard(page, name)).toBeVisible();
  };

  test("every account state shows once, in the banner, and repo lines only while the bot is usable", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"];
    await stub(page, { accountNext: () => current.report, ready: () => current.ready });
    for (const [key, entry] of Object.entries(ACCOUNTS)) {
      current = entry;
      await openHome(page);
      await expect(banner(page)).toHaveCount(1);
      await expect(banner(page).locator("[data-slot=state]")).toHaveText(entry.label);
      // The account is not repeated on any repo card.
      await expect(page.locator(".repository-card", { hasText: "package is off" })).toHaveCount(0);
      if (entry.ready) await expect(line(page, "identity-ready").locator("[data-slot=state]")).toHaveText("ready");
      else for (const name of NAMES) await expect(line(page, name)).toBeHidden();
      await shot(page, `home-account-${key}`);
    }
  });

  test("banner facts, actions, and the quiet healthy line", async ({ page }) => {
    let current = ACCOUNTS["package-off"].report;
    await stub(page, { accountNext: () => current });
    await openHome(page);
    await expect(banner(page).locator("[data-slot=facts]")).toHaveText(/bot robo-bot · package off · token: repo, read:org · expires/);
    await expect(banner(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await expect(banner(page).getByRole("button", { name: "Open setup" })).toBeHidden();

    current = ACCOUNTS.healthy.report;
    await openHome(page);
    await expect(banner(page).locator("[data-slot=message]")).toBeHidden();
    await expect(banner(page).getByRole("button", { name: "Turn on" })).toBeHidden();
    await expect(banner(page).getByRole("button", { name: "Open setup" })).toBeHidden();

    current = ACCOUNTS["not-set-up"].report;
    await openHome(page);
    await expect(banner(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    // With several GitHub repos, the banner asks which one the setup runs in.
    const options = await banner(page).locator("[data-slot=repo-select] option").allTextContents();
    for (const name of NAMES) expect(options).toContain(name);

    current = ACCOUNTS["needs-attention"].report;
    await openHome(page);
    await expect(banner(page)).toContainText("Fix: Make a new token with only the repo and read:org scopes");
    await expect(banner(page).getByRole("button", { name: "Open setup" })).toBeVisible();
  });

  test("every repo state on its own card, with its checklist and, for a repo you do not run, the owner's message", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report });
    await openHome(page);
    for (const [name, entry] of Object.entries(REPOS)) {
      await expect(line(page, name).locator("[data-slot=state]")).toHaveText(entry.label);
    }
    await shot(page, "home-repos-under-healthy-account");

    const expectations = {
      "identity-ready": { done: [true, true, true], setup: false, owner: false },
      "identity-invited": { done: [true, false, true], setup: true, owner: false },
      "identity-uninvited": { done: [true, false, true], setup: true, owner: false },
      "identity-theirs": { done: [true, false, false], setup: false, owner: true },
      "identity-unverified": { done: [true, true, false], setup: false, owner: true },
      "identity-unprotected": { done: [true, true, false], setup: false, owner: false },
      "identity-bot-admin": { done: [true, false, true], setup: false, owner: false },
      "identity-unread": { done: [true, false, false], setup: false, owner: false },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      await line(page, name).getByRole("button", { name: "Details" }).click();
      await expect(card(page).locator("[data-slot=subject]")).toHaveText(name);
      await expect(card(page).locator("[data-slot=checks] li")).toHaveCount(3);
      const done = await card(page).locator("[data-slot=checks] li").evaluateAll((items) => items.map((item) => item.dataset.done === "true"));
      expect(done, name).toEqual(expected.done);
      await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible({ visible: expected.setup });
      await expect(card(page).locator("[data-slot=owner]")).toBeVisible({ visible: expected.owner });
      if (expected.owner) {
        await expect(card(page).locator("[data-slot=owner-message]")).toContainText(`${BOT} never needs Admin`);
        await expect(card(page).getByRole("button", { name: "Copy message" })).toBeVisible();
      }
      // The account's github.com steps belong to the banner's card, not a repo's.
      await expect(card(page).locator("[data-slot=guide]")).toBeHidden();
      await shot(card(page), `repo-card-${name}`);
      await card(page).getByRole("button", { name: "Close" }).click();
    }

    // The repo menu opens the same card.
    await repoCard(page, "identity-ready").getByRole("button", { name: "Actions", exact: true }).click();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(card(page)).toContainText("The bot can work here.");
  });

  test("the account card frames the github.com steps as the bot's, with addresses to copy and done steps dimmed", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    await stub(page, { accountNext: () => current, ready: () => false });
    const steps = () => card(page).locator("[data-slot=steps] li");
    const doneOf = () => steps().evaluateAll((items) => items.map((item) => [item.querySelector("[data-slot=label]").textContent, item.dataset.done === "true"]));

    await openHome(page);
    await banner(page).getByRole("button", { name: "Details" }).click();
    const panel = card(page).getByRole("region", { name: "On github.com, signed in as the bot" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Do these as the bot account, not as you.");
    // Addresses to copy, never links that would open in your own signed-in browser.
    await expect(panel.locator("a")).toHaveCount(0);
    await expect(panel.locator("[data-slot=url]").nth(1)).toHaveText("https://github.com/settings/tokens/new");
    await expect(panel.getByRole("button", { name: "Copy link" })).toHaveCount(2);
    expect(await doneOf()).toEqual([["Create the bot account", false], ["Create a classic token", false]]);
    await shot(card(page), "account-card-not-set-up");
    await card(page).getByRole("button", { name: "Close" }).click();

    // An expired token: the account exists (done, dimmed) and the token step becomes renewing it.
    current = ACCOUNTS["token-expired"].report;
    await openHome(page);
    await banner(page).getByRole("button", { name: "Details" }).click();
    expect(await doneOf()).toEqual([["Create the bot account", true], ["Renew the token", false]]);
    await expect(steps().first()).toHaveCSS("opacity", "0.55");
    await shot(card(page), "account-card-token-expired");
    await card(page).getByRole("button", { name: "Close" }).click();

    // A working account: its checklist confirms the bot, the token, and the package.
    current = ACCOUNTS["package-off"].report;
    await openHome(page);
    await banner(page).getByRole("button", { name: "Details" }).click();
    const checks = await card(page).locator("[data-slot=checks] li").evaluateAll((items) => items.map((item) => item.dataset.done === "true"));
    expect(checks).toEqual([true, true, false]);
    await expect(card(page).locator("[data-slot=guide]")).toBeHidden();
    await expect(card(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await shot(card(page), "account-card-package-off");
  });

  test("Turn on posts no body and the banner and repo lines follow", async ({ page }) => {
    let on = false;
    const { posts } = await stub(page, {
      accountNext: () => (on ? ACCOUNTS.healthy.report : ACCOUNTS["package-off"].report),
      enable: () => { on = true; return { enabled: true, account: ACCOUNTS.healthy.report }; },
    });
    await openHome(page);
    await banner(page).getByRole("button", { name: "Turn on" }).click();
    await expect(banner(page).locator("[data-slot=state]")).toHaveText("on");
    await expect(banner(page)).toContainText("ones already open keep acting as you until restarted");
    expect(posts).toEqual([{ kind: "enable", body: "{}" }]);
  });

  test("Open setup posts no body, and coming back re-reads the account and only that repo", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    const { reads, posts } = await stub(page, { accountNext: () => current, ready: () => current.state !== "not-set-up" });
    await openHome(page);
    await banner(page).locator("[data-slot=repo-select]").selectOption({ label: "identity-invited" });
    await banner(page).getByRole("button", { name: "Open setup" }).click();
    await expect(banner(page)).toContainText("A terminal opened running roborepo github setup in identity-invited's folder.");
    expect(posts).toEqual([{ kind: "setup", repositoryId: "git:github.com/example/identity-invited", body: "{}" }]);

    current = ACCOUNTS.healthy.report;
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(banner(page).locator("[data-slot=state]")).toHaveText("on");
    await expect(line(page, "identity-invited").locator("[data-slot=state]")).toHaveText("invite pending");
    expect(reads.filter((read) => read.fresh)).toEqual([{ kind: "account", fresh: true }, { kind: "repo", name: "identity-invited", fresh: true }]);
  });

  test("where the button cannot open a terminal, or did not, the command is shown to copy", async ({ page }) => {
    await stub(page, {
      accountNext: () => ({ ...ACCOUNTS["not-set-up"].report, setupLaunch: { supported: false } }),
      ready: () => false,
    });
    await openHome(page);
    await expect(banner(page).getByRole("button", { name: "Open setup" })).toBeHidden();
    await expect(banner(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      launch: { launched: false, reason: "launch_failed", error: "open exited 1" },
    });
    await openHome(page);
    await line(page, "identity-uninvited").getByRole("button", { name: "Details" }).click();
    await expect(card(page).locator("[data-slot=command-row]")).toBeHidden();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("The terminal did not open. Run the command below in your own terminal instead.");
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
  });

  test("a repo the server turns down shows no line; the banner stays", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report, repoNext: () => ({ applies: false }) });
    await openHome(page);
    for (const name of NAMES) await expect(line(page, name)).toBeHidden();
    await expect(banner(page)).toBeVisible();
  });
});
