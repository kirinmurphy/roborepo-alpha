// The GitHub bot identity on Home. While the package is off: the info offer above the repo list
// (Set it up, or Turn on when the bot is ready) and its lasting "No thanks". Once the package is on:
// the "agent bot" badge on each GitHub repo, whose color carries the account's state as well as the
// repo's, and the card behind it, which says everything on its own (account, token, invitation,
// branch rules, the owner's message, the github.com steps). Also **Turn on**, **Open setup** (which
// only asks the server to open the terminal setup), the copy-command fallback, and the refresh when
// the user comes back. The server side is covered by repository-agent-identity-check.mjs, so these
// tests answer its routes with fixed reports.
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
  enableOffered: false, offerDismissed: false, setupLaunch: { supported: true }, guide, ...overrides,
});

// Every account state. `ready` says whether repos are read past the account; with the package on,
// `badge` and `label` are what the ready repo's badge shows under that account.
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
  healthy: { ready: true, badge: "ok", label: "ready", report: account() },
  "renew-soon": {
    ready: true, badge: "warn", label: "renew soon",
    report: account({ expiresAt: "2026-11-29T12:00:00.000Z", findings: [finding("expiring", "warn", "The bot's token expires in 5 days.")] }),
  },
  "token-expired": {
    ready: false, badge: "problem", label: "token expired",
    report: account({ state: "problem", botLogin: null, expiresAt: null, scopes: null, findings: [finding("expired", "problem", "GitHub rejected the bot's token (it expired or was revoked).")] }),
  },
  "needs-attention": {
    ready: true, badge: "problem", label: "needs attention",
    report: account({
      state: "problem", scopes: ["repo", "read:org", "workflow"],
      findings: [finding("broad-scopes", "problem", "The bot's token has broader access than agents need (workflow).", "Make a new token with only the repo and read:org scopes, then run roborepo github setup in your own terminal.")],
    }),
  },
  "not-checked": {
    ready: false, badge: "muted", label: "not checked",
    report: account({ state: "unavailable", botLogin: null, expiresAt: null, scopes: null, reason: "GitHub could not be reached" }),
  },
  // Turned on from the Agents page before any bot exists: agents cannot use GitHub at all.
  "on-not-set-up": {
    ready: false, badge: "problem", label: "not set up",
    report: account({ state: "not-set-up", botLogin: null, savedLogin: null, signedIn: false, expiresAt: null, scopes: null }),
  },
};

const repoReport = (name, state, findings = [], overrides = {}) => ({
  applies: true, account: "ready", state, repository: `example/${name}`, botLogin: BOT, userAdmin: true, reason: null,
  findings, ownerMessage: null, setupLaunch: { supported: true }, ...overrides,
});

// Every repo state a badge can show, each on its own repo, with its dot's level.
const REPOS = {
  "identity-ready": { badge: "ok", label: "ready", report: (name) => repoReport(name, "healthy") },
  "identity-invited": {
    badge: "problem", label: "invite pending",
    report: (name) => repoReport(name, "problem", [finding("invite-pending", "problem", `${BOT} has been invited to example/${name} but has not accepted yet.`, "Run roborepo github setup in this repo, in your own terminal; it accepts the invitation as the bot.")]),
  },
  "identity-uninvited": {
    badge: "problem", label: "not invited",
    report: (name) => repoReport(name, "problem", [finding("not-collaborator", "problem", `${BOT} cannot push to example/${name}.`, "Run roborepo github setup in this repo, in your own terminal; it sends the invitation.")]),
  },
  "identity-theirs": {
    badge: "problem", label: "not invited",
    report: (name) => repoReport(name, "problem", [
      finding("not-collaborator", "problem", `${BOT} is not a collaborator on example/${name}, and you are not an admin there, so setup cannot invite it.`, `Ask the repo's owner to invite ${BOT} with Write access; send them the message below.`, true),
      finding("protection", "problem", "Branch protection for this repo is missing, so GitHub does not stop the bot from merging unreviewed work.", "Ask the repo's owner to add the branch rules; send them the message below.", true),
    ], { userAdmin: false, ownerMessage: ownerMessage({ repo: `example/${name}`, botLogin: BOT }) }),
  },
  "identity-unverified": {
    badge: "warn", label: "rules unverified",
    report: (name) => repoReport(name, "unverified", [
      finding("protection-unverified", "unverified", "GitHub applies the branch rules, but you are not an admin of this repo, so RoboRepo cannot see who may bypass them.", "Ask the repo's owner to confirm them, and that the bot cannot bypass them; send them the message below.", true),
    ], { userAdmin: false, ownerMessage: ownerMessage({ repo: `example/${name}`, botLogin: BOT, invite: false }) }),
  },
  "identity-unprotected": {
    badge: "problem", label: "branch rules missing",
    report: (name) => repoReport(name, "problem", [finding("protection", "problem", "Branch protection for this repo is missing, so GitHub does not stop the bot from merging unreviewed work.", "Run roborepo protect in this repo (it asks before changing anything), or open Branch protection in the repo's menu on Home.")]),
  },
  "identity-bot-admin": {
    badge: "problem", label: "too much access",
    report: (name) => repoReport(name, "problem", [finding("bot-is-admin", "problem", `${BOT} is an admin of example/${name}, so it could change the branch protection meant to limit it.`, `Lower ${BOT} to write access in the repo's collaborator settings, then rerun roborepo github status.`)]),
  },
  "identity-unread": {
    badge: "muted", label: "not checked",
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
  // "waiting" while the account cannot be used), the setup route with `launch`, the enable route
  // with `enable()`, and "No thanks" with `{ offerDismissed: true }`. Records each read and post.
  async function stub(page, { accountNext, repoNext = (name) => REPOS[name].report(name), ready = () => true, launch = { launched: true }, enable = null }) {
    const reads = [];
    const posts = [];
    await page.route(/\/api\/agent-identity(\/enable|\/dismiss-offer)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST") {
        const kind = url.pathname.endsWith("/dismiss-offer") ? "dismiss" : "enable";
        posts.push({ kind, body: route.request().postData() });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(kind === "enable" ? enable() : { offerDismissed: true }) });
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

  const offer = (page) => page.locator(".agent-identity-offer");
  const repoCard = (page, name) => page.locator(".repository-card").filter({ has: page.getByRole("heading", { name, exact: true }) });
  const badge = (page, name) => repoCard(page, name).locator(".agent-identity-badge");
  const card = (page) => page.getByRole("dialog", { name: "Agent GitHub account" });
  const openHome = async (page) => {
    await page.goto("/");
    for (const name of NAMES) await expect(repoCard(page, name)).toBeVisible();
  };
  const doneOf = (list) => list.evaluateAll((items) => items.map((item) => item.dataset.done === "true"));

  test("while the package is off, Home offers the setup, and No thanks hides it for good", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    const { posts } = await stub(page, { accountNext: () => current, ready: () => false });
    await openHome(page);
    await expect(offer(page)).toHaveClass(/notice-info/);
    await expect(offer(page)).toContainText("Give them their own GitHub bot account");
    await expect(offer(page).getByRole("button", { name: "Set it up" })).toBeVisible();
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeHidden();
    // With the package off, no repo carries a badge.
    for (const name of NAMES) await expect(badge(page, name)).toBeHidden();
    await shot(page, "home-offer-not-set-up");

    current = ACCOUNTS["package-off"].report;
    await openHome(page);
    await expect(offer(page)).toContainText("robo-bot, is set up");
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await expect(offer(page).getByRole("button", { name: "Set it up" })).toBeHidden();
    await shot(page, "home-offer-package-off");

    await offer(page).getByRole("button", { name: "No thanks" }).click();
    await expect(offer(page)).toContainText("Home won't offer this again");
    await expect(offer(page).getByRole("link", { name: "Agents" })).toHaveAttribute("href", "/agents");
    expect(posts).toEqual([{ kind: "dismiss", body: "{}" }]);
    await shot(page, "home-offer-declined");

    current = { ...current, offerDismissed: true };
    await openHome(page);
    await expect(offer(page)).toBeHidden();
  });

  test("with the package on, the offer is gone and every GitHub repo carries an agent bot badge that shows the account's state too", async ({ page }) => {
    let current = ACCOUNTS.healthy;
    await stub(page, { accountNext: () => current.report, ready: () => current.ready });
    for (const [key, entry] of Object.entries(ACCOUNTS)) {
      if (!entry.report.packageEnabled) continue;
      current = entry;
      await openHome(page);
      await expect(offer(page)).toBeHidden();
      await expect(badge(page, "identity-ready")).toHaveText("agent bot");
      await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", entry.badge);
      await expect(badge(page, "identity-ready")).toHaveAttribute("title", `Agent bot: ${entry.label}`);
      await shot(page, `home-badges-account-${key}`);
    }

    current = ACCOUNTS.healthy;
    await openHome(page);
    for (const [name, entry] of Object.entries(REPOS)) {
      await expect(badge(page, name), name).toHaveAttribute("data-level", entry.badge);
      await expect(badge(page, name), name).toHaveAttribute("title", `Agent bot: ${entry.label}`);
    }
    await shot(page, "home-badges-repos-under-healthy-account");
  });

  test("every repo state's card says everything about the bot there, account included", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report });
    await openHome(page);
    const expectations = {
      "identity-ready": { done: [true, true, true, true], setup: false, owner: false },
      "identity-invited": { done: [true, true, false, true], setup: true, owner: false },
      "identity-uninvited": { done: [true, true, false, true], setup: true, owner: false },
      "identity-theirs": { done: [true, true, false, false], setup: false, owner: true },
      "identity-unverified": { done: [true, true, true, false], setup: false, owner: true },
      "identity-unprotected": { done: [true, true, true, false], setup: false, owner: false },
      "identity-bot-admin": { done: [true, true, false, true], setup: false, owner: false },
      "identity-unread": { done: [true, true, false, false], setup: false, owner: false },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      await badge(page, name).click();
      await expect(card(page).locator("[data-slot=subject]")).toHaveText(name);
      await expect(card(page).locator("[data-slot=state]")).toHaveText(REPOS[name].label);
      const checks = card(page).locator("[data-slot=checks] li");
      await expect(checks.locator("[data-slot=label]")).toHaveText(["Bot account", "Token", "Invitation", "Branch rules"]);
      expect(await doneOf(checks), name).toEqual(expected.done);
      await expect(checks.first()).toContainText("robo-bot, shared by every repo");
      await expect(checks.nth(1)).toContainText("scopes repo, read:org");
      await expect(card(page)).not.toContainText("banner");
      await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible({ visible: expected.setup });
      await expect(card(page).locator("[data-slot=owner]")).toBeVisible({ visible: expected.owner });
      if (expected.owner) {
        await expect(card(page).locator("[data-slot=owner-message]")).toContainText(`${BOT} never needs Admin`);
        await expect(card(page).getByRole("button", { name: "Copy message" })).toBeVisible();
      }
      // A working account has no github.com steps left.
      await expect(card(page).locator("[data-slot=guide]")).toBeHidden();
      await shot(card(page), `repo-card-${name}`);
      await card(page).getByRole("button", { name: "Close" }).click();
    }
    // One size wider than the other Home dialogs.
    await expect(page.locator("#agent-identity-dialog")).toHaveAttribute("data-dialog-size", "lg");

    // The repo menu opens the same card.
    await repoCard(page, "identity-ready").getByRole("button", { name: "Actions", exact: true }).click();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(card(page)).toContainText("Agents can push and open pull requests here as the bot.");
  });

  test("the github.com steps are the bot's, with addresses to copy and done steps dimmed, in the offer's card and in a red badge's card", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    await stub(page, { accountNext: () => current, ready: () => Boolean(current.botLogin) });
    const steps = () => card(page).locator("[data-slot=steps] li");
    const stepsOf = () => steps().evaluateAll((items) => items.map((item) => [item.querySelector("[data-slot=label]").textContent, item.dataset.done === "true"]));

    await openHome(page);
    await offer(page).getByRole("button", { name: "Set it up" }).click();
    const panel = card(page).getByRole("region", { name: "On github.com, signed in as the bot" });
    await expect(panel).toBeVisible();
    await expect(panel).toContainText("Do these as the bot account, not as you.");
    // Addresses to copy, never links that would open in your own signed-in browser.
    await expect(panel.locator("a")).toHaveCount(0);
    await expect(panel.locator("[data-slot=url]").nth(1)).toHaveText("https://github.com/settings/tokens/new");
    await expect(panel.getByRole("button", { name: "Copy link" })).toHaveCount(2);
    expect(await stepsOf()).toEqual([["Create the bot account", false], ["Create a classic token", false]]);
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    await shot(card(page), "account-card-not-set-up");
    await card(page).getByRole("button", { name: "Close" }).click();

    // The bot is ready and only the package is off: its checklist, and Turn on.
    current = ACCOUNTS["package-off"].report;
    await openHome(page);
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Actions", exact: true }).click();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(card(page).locator("[data-slot=checks] li [data-slot=label]")).toHaveText(["Bot account", "Token", "Package", "Invitation", "Branch rules"]);
    expect(await doneOf(card(page).locator("[data-slot=checks] li"))).toEqual([true, true, false, true, true]);
    await expect(card(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await card(page).getByRole("button", { name: "Close" }).click();

    // With the package on and the token expired, a repo's badge is red and its card carries the
    // account's steps itself: the account is done (dimmed) and the token step becomes renewing it.
    current = ACCOUNTS["token-expired"].report;
    await openHome(page);
    await badge(page, "identity-ready").click();
    await expect(card(page).locator("[data-slot=state]")).toHaveText("token expired");
    expect(await stepsOf()).toEqual([["Create the bot account", true], ["Renew the token", false]]);
    await expect(steps().first()).toHaveCSS("opacity", "0.55");
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    await shot(card(page), "repo-card-token-expired");
  });

  test("Turn on posts no body; the offer goes and the badges come", async ({ page }) => {
    let on = false;
    const { posts } = await stub(page, {
      accountNext: () => (on ? ACCOUNTS.healthy.report : ACCOUNTS["package-off"].report),
      enable: () => { on = true; return { enabled: true, account: ACCOUNTS.healthy.report }; },
    });
    await openHome(page);
    await offer(page).getByRole("button", { name: "Turn on" }).click();
    await expect(offer(page)).toBeHidden();
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    expect(posts).toEqual([{ kind: "enable", body: "{}" }]);
  });

  test("Open setup posts no body, and coming back re-reads the account and only that repo", async ({ page }) => {
    let current = ACCOUNTS["token-expired"].report;
    const { reads, posts } = await stub(page, { accountNext: () => current, ready: () => current.state === "healthy" });
    await openHome(page);
    await badge(page, "identity-invited").click();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("A terminal opened running roborepo github setup in identity-invited's folder.");
    expect(posts).toEqual([{ kind: "setup", repositoryId: "git:github.com/example/identity-invited", body: "{}" }]);
    await card(page).getByRole("button", { name: "Close" }).click();

    current = ACCOUNTS.healthy.report;
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(badge(page, "identity-invited")).toHaveAttribute("title", "Agent bot: invite pending");
    expect(reads.filter((read) => read.fresh)).toEqual([{ kind: "account", fresh: true }, { kind: "repo", name: "identity-invited", fresh: true }]);
  });

  test("where the button cannot open a terminal, or did not, the command is shown to copy", async ({ page }) => {
    await stub(page, {
      accountNext: () => ({ ...ACCOUNTS["not-set-up"].report, setupLaunch: { supported: false } }),
      ready: () => false,
    });
    await openHome(page);
    await offer(page).getByRole("button", { name: "Set it up" }).click();
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
    await card(page).getByRole("button", { name: "Close" }).click();

    await page.unrouteAll({ behavior: "ignoreErrors" });
    await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      launch: { launched: false, reason: "launch_failed", error: "open exited 1" },
    });
    await openHome(page);
    await badge(page, "identity-uninvited").click();
    await expect(card(page).locator("[data-slot=command-row]")).toBeHidden();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("The terminal did not open. Run the command below in your own terminal instead.");
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
  });

  test("a repo the server turns down shows no badge", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report, repoNext: () => ({ applies: false }) });
    await openHome(page);
    for (const name of NAMES) await expect(badge(page, name)).toBeHidden();
  });
});
