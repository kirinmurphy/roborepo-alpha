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
    await expect(offer(page).getByRole("link", { name: "Settings" })).toHaveAttribute("href", "/settings");
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
      // A bot that cannot sign in turns the banner into a warning with only Fix it; otherwise none.
      if (entry.badge === "problem") {
        await expect(offer(page), key).toHaveClass(/notice-alert/);
        await expect(offer(page), key).toContainText(entry.report.state === "not-set-up" ? "cannot push or open pull requests" : "Agents can't push or open pull requests right now: robo-bot needs attention.");
        await expect(offer(page).getByRole("button", { name: "Fix it" }), key).toBeVisible();
        for (const name of ["Set it up", "Turn on", "No thanks"]) await expect(offer(page).getByRole("button", { name }), key).toBeHidden();
      } else {
        await expect(offer(page), key).toBeHidden();
      }
      await expect(badge(page, "identity-ready")).toHaveText("agent bot");
      await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", entry.badge);
      await expect(badge(page, "identity-ready")).toHaveAttribute("title", `Agent bot: ${entry.label}`);
      await shot(page, `home-badges-account-${key}`);
    }

    current = ACCOUNTS["token-expired"];
    await openHome(page);
    await offer(page).getByRole("button", { name: "Fix it" }).click();
    await expect(card(page)).toBeVisible();
    await expect(card(page)).toContainText("Bot account (all repos)");
    await page.keyboard.press("Escape");

    current = ACCOUNTS.healthy;
    await openHome(page);
    for (const [name, entry] of Object.entries(REPOS)) {
      await expect(badge(page, name), name).toHaveAttribute("data-level", entry.badge);
      await expect(badge(page, name), name).toHaveAttribute("title", `Agent bot: ${entry.label}`);
    }
    await shot(page, "home-badges-repos-under-healthy-account");
  });

  test("every repo state's card is one numbered list in setup order, account included", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report });
    await openHome(page);
    const expectations = {
      "identity-ready": { done: [true, true, true, true, true], summary: "Agents act on GitHub as robo-bot.", setup: false, owner: false },
      "identity-invited": { done: [true, true, true, false, true], summary: "Start at item 4.", setup: true, owner: false },
      "identity-uninvited": { done: [true, true, true, false, true], summary: "Start at item 4.", setup: true, owner: false },
      "identity-theirs": { done: [true, true, true, false, false], summary: "Start at item 4.", setup: false, owner: true },
      "identity-unverified": { done: [true, true, true, true, false], summary: "Agents can work, but item 5 needs you soon.", setup: false, owner: true },
      "identity-unprotected": { done: [true, true, true, true, false], summary: "Start at item 5.", setup: false, owner: false },
      "identity-bot-admin": { done: [true, true, true, false, true], summary: "Start at item 4.", setup: false, owner: false },
      "identity-unread": { done: [true, true, true, false, false], summary: "GitHub did not answer. Check again in a moment.", setup: false, owner: false },
    };
    for (const [name, expected] of Object.entries(expectations)) {
      await badge(page, name).click();
      await expect(card(page).locator("[data-slot=subject]")).toHaveText(name);
      await expect(card(page).locator("[data-slot=state]")).toHaveText(REPOS[name].label);
      await expect(card(page).locator("[data-slot=message]")).toHaveText(expected.summary);
      const steps = card(page).locator("[data-slot=steps] > li");
      await expect(steps.locator(".agent-identity-step-head [data-slot=label]")).toHaveText(["Bot account", "Token", "Agents use the bot", "Invited to this repo", "Branch rules"]);
      await expect(steps.locator("[data-slot=number]")).toHaveText(["1.", "2.", "3.", "4.", "5."]);
      expect(await doneOf(steps), name).toEqual(expected.done);
      await expect(steps.nth(1)).toContainText("repo, read:org · expires");
      // No second checklist, no separate github.com panel, no "Fix:" line repeating an item.
      await expect(card(page).locator("ul, section")).toHaveCount(0);
      await expect(card(page)).not.toContainText("Fix:");
      await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible({ visible: expected.setup });
      await expect(card(page).locator("[data-slot=owner]")).toBeVisible({ visible: expected.owner });
      if (expected.owner) {
        await expect(steps.filter({ hasText: "Ask the owner; the message below says what to do." })).not.toHaveCount(0);
        await expect(card(page).locator("[data-slot=owner-message]")).toContainText(`${BOT} never needs Admin`);
        await expect(card(page).getByRole("button", { name: "Copy message" })).toBeVisible();
      }
      await shot(card(page), `repo-card-${name}`);
      await card(page).getByRole("button", { name: "Close" }).click();
    }
    // One size wider than the other Home dialogs.
    await expect(page.locator("#agent-identity-dialog")).toHaveAttribute("data-dialog-size", "lg");

    // The repo menu opens the same card.
    await repoCard(page, "identity-ready").getByRole("button", { name: "Actions", exact: true }).click();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Agents act on GitHub as robo-bot.");
  });

  test("an item done on github.com carries the address to copy into the bot's browser, and done items are dimmed", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    await stub(page, { accountNext: () => current, ready: () => Boolean(current.botLogin) });
    const steps = () => card(page).locator("[data-slot=steps] > li");
    const urls = () => steps().evaluateAll((items) => items.map((item) => {
      const row = item.querySelector("[data-slot=url-row]");
      return row.hidden ? null : item.querySelector("[data-slot=url]").textContent;
    }));

    await openHome(page);
    await offer(page).getByRole("button", { name: "Set it up" }).click();
    await expect(card(page).locator("[data-slot=subject]")).toHaveText("Bot account (all repos)");
    await expect(steps().locator(".agent-identity-step-head [data-slot=label]")).toHaveText(["Bot account", "Token", "Agents use the bot"]);
    expect(await doneOf(steps())).toEqual([false, false, false]);
    expect(await urls()).toEqual(["https://github.com/signup", "https://github.com/settings/tokens/new", null]);
    await expect(steps().nth(2)).toContainText("The setup turns this on when it finishes.");
    // Addresses to copy, never links that would open in your own signed-in browser.
    await expect(card(page).locator("a")).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Copy link" })).toHaveCount(2);
    await expect(card(page).locator("[data-slot=bot-browser]")).toHaveText("Open copied links where the bot is signed in, not in your own browser.");
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeVisible();
    await shot(card(page), "account-card-not-set-up");
    await card(page).getByRole("button", { name: "Close" }).click();

    // The bot is ready and only agents' switch is off: Turn on, no addresses.
    current = ACCOUNTS["package-off"].report;
    await openHome(page);
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Actions", exact: true }).click();
    await repoCard(page, "identity-ready").getByRole("button", { name: "Agent GitHub account" }).click();
    await expect(steps()).toHaveCount(5);
    expect(await doneOf(steps())).toEqual([true, true, false, true, true]);
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 3.");
    await expect(card(page).locator("[data-slot=bot-browser]")).toBeHidden();
    await expect(card(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    await shot(card(page), "repo-card-package-off");
    await card(page).getByRole("button", { name: "Close" }).click();

    // With agents switched on and the token expired, a repo's badge is red and its card carries the
    // renewal itself; the repo's own items wait for a working account.
    current = ACCOUNTS["token-expired"].report;
    await openHome(page);
    await badge(page, "identity-ready").click();
    await expect(card(page).locator("[data-slot=state]")).toHaveText("token expired");
    await expect(steps()).toHaveCount(5);
    expect(await doneOf(steps())).toEqual([true, false, true, false, false]);
    expect(await urls()).toEqual([null, "https://github.com/settings/tokens", null, null, null]);
    await expect(steps().nth(3)).toContainText("checked once the bot account works");
    await expect(steps().first()).toHaveCSS("opacity", "0.55");
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 2.");
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

  test("finishing while the card is open shows All set, drops the progress note and Check again, and closes", async ({ page }) => {
    let current = ACCOUNTS["token-expired"].report;
    await stub(page, { accountNext: () => current, ready: () => current.state === "healthy" });
    await openHome(page);
    await badge(page, "identity-ready").click();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page).locator("[data-slot=launch-note]")).toContainText("A terminal opened");
    await expect(card(page).getByRole("button", { name: "Check again" })).toBeVisible();

    // The setup finished; coming back to the window re-reads and every item is done.
    current = ACCOUNTS.healthy.report;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    await expect(card(page).locator("[data-slot=launch-note]")).toBeHidden();
    await expect(card(page).getByRole("button", { name: "Check again" })).toBeHidden();
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
    await shot(card(page), "repo-card-all-set");
    await expect(card(page)).toBeHidden({ timeout: 8_000 });

    // Opened when already complete: no Check again, no countdown, and it stays open.
    await badge(page, "identity-ready").click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Agents act on GitHub as robo-bot.");
    await expect(card(page).getByRole("button", { name: "Check again" })).toBeHidden();
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
  test("Settings holds the one switch: Set it up links to Home's card, Turn on only for a ready bot, Turn off once on", async ({ page }) => {
    let current = ACCOUNTS["not-set-up"].report;
    const { posts } = await stub(page, {
      accountNext: () => current,
      ready: () => Boolean(current.botLogin),
      enable: () => { current = ACCOUNTS.healthy.report; return { enabled: true, account: current }; },
    });
    const disables = [];
    await page.route("**/api/config/packages", async (route) => {
      disables.push(route.request().postData());
      current = ACCOUNTS["package-off"].report;
      return route.fulfill({ json: { ok: true } });
    });
    const row = page.locator("#agent-identity-row");

    await page.goto("/settings");
    await expect(row.getByRole("status")).toHaveText("Off: agents act on GitHub as you.");
    await expect(row.getByRole("link", { name: "Set it up" })).toHaveAttribute("href", "/?agent-identity=setup");
    await expect(row.getByRole("button")).toBeHidden();
    await shot(row, "settings-not-set-up");

    // The link opens Home's account card, and the parameter is spent.
    await row.getByRole("link", { name: "Set it up" }).click();
    await expect(card(page).locator("[data-slot=subject]")).toHaveText("Bot account (all repos)");
    await expect(page).toHaveURL(/\/$/);

    current = ACCOUNTS["package-off"].report;
    await page.goto("/settings");
    await expect(row.getByRole("status")).toHaveText("robo-bot is ready; agents act as you.");
    await row.getByRole("button", { name: "Turn on" }).click();
    await expect(row.getByRole("status")).toHaveText(/^robo-bot · token expires /);
    await expect(row.getByText("Agents use their bot account")).toBeVisible();
    expect(posts).toEqual([{ kind: "enable", body: "{}" }]);
    await shot(row, "settings-on");

    await row.getByRole("button", { name: "Turn off" }).click();
    await expect(row.getByRole("status")).toHaveText("robo-bot is ready; agents act as you.");
    expect(disables.map((body) => JSON.parse(body))).toEqual([{ id: "github-agent-identity", enabled: false }]);
  });
});
