// The GitHub bot identity on Home. While the package is off: the info offer above the repo list
// (Set it up, or Turn on when the bot is ready) and its lasting "No thanks". Once the package is on:
// the "agent bot" badge on each GitHub repo, whose color carries the account's state as well as the
// repo's, and the card behind it, which says everything on its own (account, token, invitation,
// branch rules, the owner's message, the github.com steps). Also **Turn on**, **Open setup** (which
// only asks the server to open the terminal setup), the copy-command fallback, the refresh when
// the user comes back, and Home's poll picking up a package turned on or off in a terminal. The server side is covered by repository-agent-identity-check.mjs, so these
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
  // On and the bot works, but agents' Git settings predate the include: gh uses the bot, pushes do not.
  "git-not-routed": {
    ready: true, badge: "problem", label: "needs attention",
    report: account({
      state: "problem",
      findings: [finding("git-not-routed", "problem", "Agents' git pushes still go out as you, because your harness settings don't include the bot's Git settings yet.", "Run roborepo update, then start new agent sessions.")],
    }),
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
  // "waiting" while the account cannot be used; `null` stands for a failed read), the setup route with `launch`, the enable route
  // with `enable()`, and "No thanks" with `{ offerDismissed: true }`. Records each read and post.
  async function stub(page, { accountNext, repoNext = (name) => REPOS[name].report(name), ready = () => true, launch = { launched: true }, enable = null, update = null, invite = null }) {
    const reads = [];
    const posts = [];
    await page.route(/\/api\/agent-identity(\/enable|\/dismiss-offer|\/update)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      if (route.request().method() === "POST") {
        const kind = url.pathname.split("/").pop() === "dismiss-offer" ? "dismiss" : url.pathname.split("/").pop();
        posts.push({ kind, body: route.request().postData() });
        const answer = kind === "enable" ? await enable() : kind === "update" ? await update() : { offerDismissed: true };
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(answer) });
      }
      const fresh = url.searchParams.get("fresh") === "1";
      reads.push({ kind: "account", fresh });
      const answer = await accountNext({ fresh });
      // `null` stands for a failed read.
      if (answer === null) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "read failed" }) });
      return route.fulfill({ contentType: "application/json", body: JSON.stringify(answer) });
    });
    await page.route(/\/api\/repositories\/[^/]+\/agent-identity(\/setup|\/invite)?(\?.*)?$/, async (route) => {
      const url = new URL(route.request().url());
      const repositoryId = decodeURIComponent(url.pathname.split("/")[3]);
      const name = repositoryId.split("/").pop();
      if (route.request().method() === "POST") {
        const kind = url.pathname.endsWith("/invite") ? "invite" : "setup";
        posts.push({ kind, repositoryId, body: route.request().postData() });
        return route.fulfill({ contentType: "application/json", body: JSON.stringify(kind === "invite" ? await invite(name) : launch) });
      }
      const fresh = url.searchParams.get("fresh") === "1";
      reads.push({ kind: "repo", name, fresh });
      const body = !REPOS[name] ? { applies: false }
        : ready() ? await repoNext(name, { fresh }) : { applies: true, account: "waiting", state: null, findings: [], setupLaunch: { supported: true } };
      if (body === null) return route.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "read failed" }) });
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
  // Moves the fake clock on until `ready()` holds, one Home poll at a time.
  const pollUntil = (page, ready) => expect(async () => {
    await page.clock.fastForward(10_000);
    expect(ready()).toBe(true);
  }).toPass({ intervals: [200] });

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

    // A bot that exists but cannot be used yet is named, with Fix it, not offered from scratch.
    const unfinished = current;
    current = account({
      state: "problem", packageEnabled: false,
      findings: [finding("token-in-keychain", "problem", "The bot's token is in the keychain, which agent sandboxes cannot read.")],
    });
    await openHome(page);
    await expect(offer(page)).toHaveClass(/notice-info/);
    await expect(offer(page)).toContainText("robo-bot, needs attention before agents can use it");
    await expect(offer(page).getByRole("button", { name: "Fix it" })).toBeVisible();
    for (const name of ["Set it up", "Turn on"]) await expect(offer(page).getByRole("button", { name })).toBeHidden();
    await expect(offer(page).getByRole("button", { name: "No thanks" })).toBeVisible();
    await shot(page, "home-offer-bot-unfinished");
    current = unfinished;
    await openHome(page);

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
        // What is wrong, then its fix, and nothing else. Pushes going out as the user get Update now,
        // which is the fix, in place of Fix it.
        const shown = entry.report.findings.find((item) => item.severity === "problem");
        const updatable = key === "git-not-routed";
        const expected = entry.report.state === "not-set-up" ? /cannot push or open pull requests/ : updatable ? shown.message : `${shown.message} ${shown.fix}`;
        await expect(offer(page).locator("[data-slot=message]"), key).toHaveText(expected);
        await expect(offer(page).getByRole("button", { name: updatable ? "Update now" : "Fix it" }), key).toBeVisible();
        await expect(offer(page).getByRole("button", { name: updatable ? "Fix it" : "Update now" }), key).toBeHidden();
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

    // Pushes that still go out as the user leave "Agents use the bot" open, with Update now.
    current = ACCOUNTS["git-not-routed"];
    await openHome(page);
    await badge(page, "identity-ready").click();
    const useItem = card(page).locator("[data-slot=steps] > li").filter({ hasText: "Agents use the bot" });
    await expect(useItem).toHaveAttribute("data-done", "false");
    await expect(useItem).toContainText("Agents' git pushes still go out as you, because your harness settings don't include the bot's Git settings yet.");
    await expect(useItem).toContainText("Update now, then start new agent sessions.");
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 3.");
    await expect(card(page).getByRole("button", { name: "Update now" })).toBeVisible();
    await shot(page, "card-git-not-routed");
    await page.keyboard.press("Escape");

    // Every item checked but the account still reports something no item covers: the line above the
    // list says what and how to fix it, not a green sentence under the label.
    const caStale = finding("ca-bundle-stale", "warn", "The certificate bundle copy Codex's sandbox uses for Git is missing or out of date.", "Run roborepo github setup to refresh it.");
    current = { ...ACCOUNTS.healthy, report: account({ findings: [caStale] }) };
    await openHome(page);
    await badge(page, "identity-ready").click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText(`${caStale.message} ${caStale.fix}`);
    expect(await doneOf(card(page).locator("[data-slot=steps] > li"))).toEqual([true, true, true, true, true]);
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
      "identity-ready": { done: [true, true, true, true, true], summary: "Agents act on GitHub as robo-bot.", button: null, owner: false },
      "identity-invited": { done: [true, true, true, false, true], summary: "Start at item 4.", button: "Accept invitation", owner: false },
      "identity-uninvited": { done: [true, true, true, false, true], summary: "Start at item 4.", button: "Invite the bot", owner: false },
      "identity-theirs": { done: [true, true, true, false, false], summary: "Start at item 4.", button: null, owner: true },
      "identity-unverified": { done: [true, true, true, true, false], summary: "Agents can work, but item 5 needs you soon.", button: null, owner: true },
      "identity-unprotected": { done: [true, true, true, true, false], summary: "Start at item 5.", button: "Protect branches", owner: false },
      "identity-bot-admin": { done: [true, true, true, false, true], summary: "Start at item 4.", button: null, owner: false },
      "identity-unread": { done: [true, true, true, false, false], summary: "GitHub did not answer. Check again in a moment.", button: null, owner: false },
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
      // One thing to do at a time: at most one action button, on the item to start at, and no
      // terminal command beside it. Check again only when GitHub did not answer.
      const actions = card(page).locator("[data-slot=run]:visible");
      await expect(actions).toHaveCount(expected.button ? 1 : 0);
      if (expected.button) {
        await expect(actions).toHaveText(expected.button);
        await expect(card(page).locator("li[data-current=true] [data-slot=run]")).toHaveText(expected.button);
      }
      await expect(card(page).locator("[data-slot=command-row]")).toBeHidden();
      await expect(card(page).getByRole("button", { name: "Check again" })).toBeVisible({ visible: name === "identity-unread" });
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
    // Only the item to start at says what to do; the others wait their turn.
    expect(await urls()).toEqual(["https://github.com/signup", null, null]);
    await expect(steps().nth(0)).toContainText("Then Open setup asks for its login in a terminal.");
    await expect(steps().nth(2)).not.toContainText("The setup turns this on");
    // Addresses to copy, never links that would open in your own signed-in browser.
    await expect(card(page).locator("a")).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Copy link" })).toHaveCount(1);
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

  test("a card button waiting on the server is disabled and shows a spinner with what it is doing", async ({ page }) => {
    let on = false;
    let release;
    const held = () => new Promise((resolve) => { release = resolve; });
    const { reads } = await stub(page, {
      accountNext: () => (on ? ACCOUNTS.healthy.report : ACCOUNTS["package-off"].report),
      enable: async () => { await held(); on = true; return { enabled: true, account: ACCOUNTS.healthy.report }; },
      invite: async (name) => { await held(); return { invited: true, repository: { repositoryId: `git:github.com/example/${name}`, ...REPOS["identity-ready"].report(name) } }; },
    });
    // The account card, as Settings' "Set it up" opens it, then its Turn on.
    await page.goto("/?agent-identity=setup");
    await expect(card(page)).toBeVisible();
    const turnOn = card(page).getByRole("button", { name: "Turn on" });
    await turnOn.click();
    const waiting = card(page).getByRole("button", { name: "Turning on…" });
    await expect(waiting).toBeDisabled();
    await expect(waiting).toHaveAttribute("aria-busy", "true");
    await expect(waiting.locator(".button-spinner")).toBeVisible();
    await shot(card(page), "card-turning-on");
    release();
    await expect(card(page).locator(".button-spinner")).toHaveCount(0);
    await expect(card(page).getByRole("button", { name: "Turning on…" })).toHaveCount(0);
    await page.keyboard.press("Escape");

    // Invite the bot goes through the same busy state.
    await badge(page, "identity-uninvited").click();
    await card(page).getByRole("button", { name: "Invite the bot" }).click();
    const inviting = card(page).getByRole("button", { name: "Inviting…" });
    await expect(inviting).toBeDisabled();
    await expect(inviting.locator(".button-spinner")).toBeVisible();
    // Coming back to the window redraws the card from the same status: the button stays busy, so a
    // second click cannot send another invite.
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => reads.some((read) => read.kind === "repo" && read.name === "identity-uninvited" && read.fresh)).toBe(true);
    await page.waitForTimeout(500);
    await expect(inviting).toBeDisabled();
    await expect(card(page).getByRole("button", { name: "Invite the bot" })).toHaveCount(0);
    release();
    await expect(card(page).locator(".button-spinner")).toHaveCount(0);
  });

  test("Update now posts no body; the banner says what it means for open sessions, and the card's item 3 is checked", async ({ page }) => {
    let routed = false;
    const { posts } = await stub(page, {
      accountNext: () => (routed ? ACCOUNTS.healthy.report : ACCOUNTS["git-not-routed"].report),
      update: () => { routed = true; return { applied: true, account: ACCOUNTS.healthy.report }; },
    });
    await openHome(page);
    await offer(page).getByRole("button", { name: "Update now" }).click();
    await expect(offer(page)).not.toHaveClass(/notice-alert/);
    await expect(offer(page).locator("[data-slot=message]")).toHaveText("Updated. New agent sessions push as the bot; ones already open still push as you until restarted.");
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    expect(posts).toEqual([{ kind: "update", body: "{}" }]);
    await shot(page, "banner-updated");
    await offer(page).getByRole("button", { name: "OK" }).click();
    await expect(offer(page)).toBeHidden();

    // From the card: the footer button, then every item checked.
    routed = false;
    await openHome(page);
    await badge(page, "identity-ready").click();
    await card(page).getByRole("button", { name: "Update now" }).click();
    await expect(card(page).locator("[data-slot=steps] > li").nth(2)).toHaveAttribute("data-done", "true");
    expect(await doneOf(card(page).locator("[data-slot=steps] > li"))).toEqual([true, true, true, true, true]);
    await expect(card(page).getByRole("button", { name: "Update now" })).toBeHidden();
    expect(posts.map((post) => post.kind)).toEqual(["update", "update"]);
  });

  test("a failed Update now keeps the warning and says why", async ({ page }) => {
    await stub(page, {
      accountNext: () => ACCOUNTS["git-not-routed"].report,
      update: () => ({ applied: false, reason: "apply_failed", message: "The update did not finish: exit 1", account: ACCOUNTS["git-not-routed"].report }),
    });
    await openHome(page);
    await offer(page).getByRole("button", { name: "Update now" }).click();
    await expect(offer(page)).toHaveClass(/notice-alert/);
    await expect(offer(page).locator("[data-slot=note]")).toHaveText("The update did not finish: exit 1");
    await expect(offer(page).getByRole("button", { name: "Update now" })).toBeEnabled();
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

  test("finishing while the card is open shows All set, drops the progress note, and closes", async ({ page }) => {
    let current = ACCOUNTS["token-expired"].report;
    await stub(page, { accountNext: () => current, ready: () => current.state === "healthy" });
    await openHome(page);
    await badge(page, "identity-ready").click();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page).locator("[data-slot=launch-note]")).toContainText("A terminal opened");
    await expect(card(page).getByRole("button", { name: "Check again" })).toBeHidden();

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
      accountNext: () => ACCOUNTS["token-expired"].report,
      launch: { launched: false, reason: "launch_failed", error: "open exited 1" },
    });
    await openHome(page);
    await badge(page, "identity-ready").click();
    await expect(card(page).locator("[data-slot=command-row]")).toBeHidden();
    await card(page).getByRole("button", { name: "Open setup" }).click();
    await expect(card(page)).toContainText("The terminal did not open. Run the command below in your own terminal instead.");
    await expect(card(page).locator("[data-slot=command]")).toHaveText("roborepo github setup");
    // The command stands in for the button rather than beside it.
    await expect(card(page).getByRole("button", { name: "Open setup" })).toBeHidden();
  });

  test("Invite the bot and Protect branches run from the card, with no terminal", async ({ page }) => {
    let invited = false;
    // Only the repo the request names is protected, so a request sent for another repo fails here.
    const protectedRepos = new Set();
    const { posts } = await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      repoNext: (name) => (name === "identity-uninvited" && invited) || protectedRepos.has(`git:github.com/example/${name}`)
        ? REPOS["identity-ready"].report(name) : REPOS[name].report(name),
      invite: (name) => { invited = true; return { invited: true, repository: { repositoryId: `git:github.com/example/${name}`, ...REPOS["identity-ready"].report(name) } }; },
    });
    const protections = [];
    await page.route(/\/api\/repositories\/[^/]+\/protection$/, async (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      const repositoryId = decodeURIComponent(new URL(route.request().url()).pathname.split("/")[3]);
      protections.push({ repositoryId, body: route.request().postData() });
      protectedRepos.add(repositoryId);
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: "protected", policies: [], changes: [], refusal: null }) });
    });
    await openHome(page);

    await badge(page, "identity-uninvited").click();
    await card(page).getByRole("button", { name: "Invite the bot" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    expect(posts).toEqual([{ kind: "invite", repositoryId: "git:github.com/example/identity-uninvited", body: "{}" }]);
    await card(page).getByRole("button", { name: "Close" }).click();

    await badge(page, "identity-unprotected").click();
    await card(page).getByRole("button", { name: "Protect branches" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    expect(protections).toEqual([{ repositoryId: "git:github.com/example/identity-unprotected", body: JSON.stringify({ action: "protect" }) }]);
  });

  test("a failed invite keeps the item open and says why", async ({ page }) => {
    await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      invite: (name) => ({ invited: false, reason: "refused", message: "GitHub refused: Must have admin rights to Repository. Only an admin of the repo can invite the bot.", repository: { repositoryId: `git:github.com/example/${name}`, ...REPOS[name].report(name) } }),
    });
    await openHome(page);
    await badge(page, "identity-uninvited").click();
    await card(page).getByRole("button", { name: "Invite the bot" }).click();
    await expect(card(page).locator("[data-slot=launch-note]")).toHaveText("GitHub refused: Must have admin rights to Repository. Only an admin of the repo can invite the bot.");
    await expect(card(page).locator("[data-slot=steps] > li").nth(3)).toHaveAttribute("data-done", "false");
  });

  test("the package turned off or on in a terminal shows on Home's next poll, with no reload", async ({ page }) => {
    await page.clock.install();
    let current = ACCOUNTS.healthy.report;
    const { reads } = await stub(page, { accountNext: () => current });
    await openHome(page);
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    await expect(offer(page)).toBeHidden();
    const accountReads = () => reads.filter((read) => read.kind === "account");
    // One poll at a time: Home skips a tick while its previous refresh is still in flight, which a
    // single jump of the fake clock can land on, so the clock moves on until a poll has gone out.
    const nextPoll = async () => {
      const before = accountReads().length;
      await expect(async () => {
        await page.clock.fastForward(10_000);
        expect(accountReads().length).toBeGreaterThan(before);
      }).toPass({ intervals: [200] });
    };

    // `roborepo package disable github-agent-identity`, run elsewhere.
    current = ACCOUNTS["package-off"].report;
    reads.length = 0;
    await nextPoll();
    for (const name of NAMES) await expect(badge(page, name), name).toBeHidden();
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeVisible();
    expect(accountReads().every((read) => !read.fresh), "the poll needs no fresh read").toBe(true);

    current = ACCOUNTS.healthy.report;
    await nextPoll();
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    await expect(offer(page)).toBeHidden();

    // An unchanged answer leaves an open card alone.
    await badge(page, "identity-invited").click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 4.");
    reads.length = 0;
    await nextPoll();
    await expect(card(page)).toBeVisible();
    expect(reads.filter((read) => read.kind === "repo")).toEqual([]);
  });

  test("a failed first account read is retried on Home's next poll", async ({ page }) => {
    await page.clock.install();
    let current = null;
    const { reads } = await stub(page, { accountNext: () => current });
    await openHome(page);
    await expect(offer(page)).toBeHidden();
    current = ACCOUNTS["package-off"].report;
    const before = reads.filter((read) => read.kind === "account").length;
    await expect(async () => {
      await page.clock.fastForward(10_000);
      expect(reads.filter((read) => read.kind === "account").length).toBeGreaterThan(before);
    }).toPass({ intervals: [200] });
    await expect(offer(page).getByRole("button", { name: "Turn on" })).toBeVisible();
  });

  test("an idle Home reads each repo again once its report is past reuse", async ({ page }) => {
    await page.clock.install();
    // Nothing on Home changes: every overview read gets the first answer back, so Home redraws
    // nothing and only its poll can notice the repo.
    let overview = null;
    await page.route(/\/api\/home(\?.*)?$/, async (route) => {
      overview ??= await (await route.fetch()).json();
      return route.fulfill({ json: overview });
    });
    let lost = false;
    const { reads } = await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      repoNext: (name) => (name === "identity-ready" && lost ? REPOS["identity-uninvited"].report(name) : REPOS[name].report(name)),
    });
    await openHome(page);
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    // The bot lost its access there while nothing on the page changed.
    lost = true;
    reads.length = 0;
    await page.clock.fastForward(5 * 60_000);
    await expect(async () => {
      await page.clock.fastForward(10_000);
      expect(reads.some((read) => read.kind === "repo" && read.name === "identity-ready")).toBe(true);
    }).toPass({ intervals: [200] });
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "problem");
    expect(reads.filter((read) => read.kind === "repo").every((read) => !read.fresh), "the poll's reads use the server's cache").toBe(true);
  });

  test("an older read answering after a fresh one does not put back the older status", async ({ page }) => {
    await page.clock.install();
    let hold = false;
    const held = new Map();
    // While `hold` is set, the poll's first account read and first read of the card's repo hang until
    // released, then answer with stale status. Every other read answers at once.
    const later = (kind, answer) => new Promise((resolve) => held.set(kind, () => resolve(answer)));
    const { reads } = await stub(page, {
      accountNext: ({ fresh }) => (hold && !fresh && !held.has("account") ? later("account", ACCOUNTS["package-off"].report) : ACCOUNTS.healthy.report),
      repoNext: (name, { fresh }) => (hold && !fresh && name === "identity-invited" && !held.has("repo") ? later("repo", REPOS["identity-uninvited"].report(name)) : REPOS[name].report(name)),
    });
    await openHome(page);
    // A card with something left to do, so coming back to the window re-reads it.
    await badge(page, "identity-invited").click();
    await expect(card(page).locator("li[data-current=true] [data-slot=run]")).toHaveText("Accept invitation");
    hold = true;
    await page.clock.fastForward(5 * 60_000);
    await expect(async () => {
      await page.clock.fastForward(10_000);
      expect(held.size).toBe(2);
    }).toPass({ intervals: [200] });
    // Coming back to the window reads both again, past every cache, and those answer first.
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect.poll(() => reads.filter((read) => read.fresh).length).toBe(2);
    await expect(card(page).locator("li[data-current=true] [data-slot=run]")).toHaveText("Accept invitation");
    for (const release of held.values()) release();
    // The released answers have nothing to wait on in the page; give them time to land if they would.
    await page.waitForTimeout(1_000);
    await expect(offer(page)).toBeHidden();
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    await expect(card(page).locator("li[data-current=true] [data-slot=run]")).toHaveText("Accept invitation");
  });

  test("coming back to the window re-reads an open card", async ({ page }) => {
    let invited = false;
    const { reads } = await stub(page, {
      accountNext: () => ACCOUNTS.healthy.report,
      repoNext: (name) => (name === "identity-invited" && invited ? REPOS["identity-ready"].report(name) : REPOS[name].report(name)),
    });
    await openHome(page);
    await badge(page, "identity-invited").click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 4.");
    // The bot accepted elsewhere (say, in its own browser).
    invited = true;
    reads.length = 0;
    await page.evaluate(() => window.dispatchEvent(new Event("focus")));
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    expect(reads.filter((read) => read.fresh)).toEqual([{ kind: "account", fresh: true }, { kind: "repo", name: "identity-invited", fresh: true }]);
  });

  test("a changed bot shows none of the old bot's repo verdicts until each repo is read for it", async ({ page }) => {
    await page.clock.install();
    const other = account({ botLogin: "other-bot", savedLogin: "other-bot" });
    let current = ACCOUNTS.healthy.report;
    let release = null;
    const { reads } = await stub(page, {
      accountNext: () => current,
      // The new bot is invited nowhere; its read of identity-ready hangs until released.
      repoNext: (name) => current !== other ? REPOS[name].report(name)
        : name === "identity-ready" ? new Promise((resolve) => { release = () => resolve(REPOS["identity-uninvited"].report(name)); })
          : REPOS["identity-uninvited"].report(name),
    });
    await openHome(page);
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    current = other;
    await pollUntil(page, () => Boolean(release));
    // The old bot's "ready" is not shown beside the new bot while its read is out.
    await expect(badge(page, "identity-ready")).toBeHidden();
    await expect(badge(page, "identity-invited")).toHaveAttribute("title", "Agent bot: not invited");
    release();
    await expect(badge(page, "identity-ready")).toHaveAttribute("title", "Agent bot: not invited");
    expect(reads.filter((read) => read.kind === "repo" && read.name === "identity-ready").length).toBeGreaterThan(1);
  });

  test("a changed saved bot whose token is also rejected shows none of the old bot's repo verdicts when its repo read fails", async ({ page }) => {
    await page.clock.install();
    // Both tokens are rejected, so GitHub names neither bot: only the saved login tells them apart.
    const rejected = (savedLogin) => account({ ...ACCOUNTS["token-expired"].report, savedLogin });
    const before = rejected(BOT);
    const after = rejected("other-bot");
    let current = before;
    const { reads } = await stub(page, {
      accountNext: () => current,
      repoNext: (name) => (current === after ? null : REPOS[name].report(name)),
    });
    await openHome(page);
    await expect(badge(page, "identity-ready")).toHaveAttribute("title", "Agent bot: token expired");
    current = after;
    reads.length = 0;
    await pollUntil(page, () => reads.some((read) => read.kind === "account"));
    await expect(badge(page, "identity-ready")).toBeHidden();
    expect(reads.some((read) => read.kind === "repo" && read.name === "identity-ready")).toBe(true);
  });

  test("a changed account reads each repo again rather than waiting on a read asked under the old one", async ({ page }) => {
    await page.clock.install();
    const other = account({ botLogin: "other-bot", savedLogin: "other-bot" });
    let current = ACCOUNTS.healthy.report;
    let releaseOld = null;
    const { reads } = await stub(page, {
      accountNext: () => current,
      // The fresh read after Protect branches hangs, then answers with the old bot's "ready".
      repoNext: (name, { fresh }) => (fresh && name === "identity-unprotected" && !releaseOld
        ? new Promise((resolve) => { releaseOld = () => resolve(REPOS["identity-ready"].report(name)); })
        : current === other ? REPOS["identity-uninvited"].report(name) : REPOS[name].report(name)),
    });
    await page.route(/\/api\/repositories\/[^/]+\/protection$/, (route) => (route.request().method() !== "POST" ? route.fallback()
      : route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: "protected", policies: [], changes: [], refusal: null }) })));
    await openHome(page);
    await badge(page, "identity-unprotected").click();
    await card(page).getByRole("button", { name: "Protect branches" }).click();
    await expect.poll(() => Boolean(releaseOld)).toBe(true);
    current = other;
    reads.length = 0;
    await pollUntil(page, () => reads.some((read) => read.kind === "account"));
    await expect(badge(page, "identity-unprotected")).toHaveAttribute("title", "Agent bot: not invited");
    releaseOld();
    await page.waitForTimeout(1_000);
    await expect(badge(page, "identity-unprotected")).toHaveAttribute("title", "Agent bot: not invited");
  });

  test("a read that started before an action and answers after it does not put back what the action fixed", async ({ page }) => {
    await page.clock.install();
    let routed = false;
    let hold = false;
    let releaseAccount = null;
    let invited = false;
    let releaseRepo = null;
    const { reads } = await stub(page, {
      accountNext: () => (hold && !releaseAccount
        ? new Promise((resolve) => { releaseAccount = () => resolve(ACCOUNTS["git-not-routed"].report); })
        : routed ? ACCOUNTS.healthy.report : ACCOUNTS["git-not-routed"].report),
      repoNext: (name, { fresh }) => (name !== "identity-uninvited" ? REPOS[name].report(name)
        : hold && !fresh && !releaseRepo ? new Promise((resolve) => { releaseRepo = () => resolve(REPOS[name].report(name)); })
          : REPOS[invited ? "identity-ready" : name].report(name)),
      update: () => { routed = true; return { applied: true, account: ACCOUNTS.healthy.report }; },
      invite: (name) => { invited = true; return { invited: true, repository: { repositoryId: `git:github.com/example/${name}`, ...REPOS["identity-ready"].report(name) } }; },
    });
    await openHome(page);
    // A poll's account read is out when Update now answers, and answers with the old warning.
    hold = true;
    await pollUntil(page, () => Boolean(releaseAccount));
    await offer(page).getByRole("button", { name: "Update now" }).click();
    await expect(offer(page).locator("[data-slot=message]")).toHaveText("Updated. New agent sessions push as the bot; ones already open still push as you until restarted.");
    releaseAccount();
    await page.waitForTimeout(1_000);
    await expect(offer(page)).not.toHaveClass(/notice-alert/);
    await expect(offer(page).locator("[data-slot=message]")).toHaveText(/^Updated\./);

    // The same for a poll's repo read that is out when Invite the bot answers.
    await badge(page, "identity-uninvited").click();
    await expect(card(page).getByRole("button", { name: "Invite the bot" })).toBeVisible();
    reads.length = 0;
    await page.clock.fastForward(5 * 60_000);
    await pollUntil(page, () => Boolean(releaseRepo));
    await card(page).getByRole("button", { name: "Invite the bot" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    releaseRepo();
    await page.waitForTimeout(1_000);
    await expect(badge(page, "identity-uninvited")).toHaveAttribute("data-level", "ok");
    await expect(card(page).locator("[data-slot=message]")).toHaveText(/^All set:/);
  });

  test("a card that finished stays open when something reopens before it closes, and closes once all is done again", async ({ page }) => {
    await page.clock.install();
    let routed = true;
    let hold = false;
    let releaseAccount = null;
    const protectedRepos = new Set();
    await stub(page, {
      accountNext: () => (hold && !releaseAccount
        ? new Promise((resolve) => { releaseAccount = () => resolve(ACCOUNTS["git-not-routed"].report); })
        : routed ? ACCOUNTS.healthy.report : ACCOUNTS["git-not-routed"].report),
      repoNext: (name) => REPOS[protectedRepos.has(name) ? "identity-ready" : name].report(name),
      update: () => { routed = true; return { applied: true, account: ACCOUNTS.healthy.report }; },
    });
    await page.route(/\/api\/repositories\/[^/]+\/protection$/, (route) => {
      if (route.request().method() !== "POST") return route.fallback();
      protectedRepos.add("identity-unprotected");
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ state: "protected", policies: [], changes: [], refusal: null }) });
    });
    await openHome(page);
    await badge(page, "identity-unprotected").click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 5.");
    hold = true;
    await pollUntil(page, () => Boolean(releaseAccount));
    await card(page).getByRole("button", { name: "Protect branches" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    // Before it closes, the account reports pushes going out as the user again.
    routed = false;
    releaseAccount();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("Start at item 3.");
    await page.clock.runFor(6_000);
    await expect(card(page)).toBeVisible();
    await card(page).getByRole("button", { name: "Update now" }).click();
    await expect(card(page).locator("[data-slot=message]")).toHaveText("All set: Agents act on GitHub as robo-bot. This closes in 5 seconds.");
    await page.clock.runFor(6_000);
    await expect(card(page)).toBeHidden();
  });

  test("a repo removed from Home is no longer read on its poll", async ({ page }) => {
    await page.clock.install();
    let removed = false;
    await page.route(/\/api\/home(\?.*)?$/, async (route) => {
      const overview = await (await route.fetch()).json();
      if (removed) overview.repositories = overview.repositories.filter((repository) => !String(repository.repositoryId).endsWith("/identity-ready"));
      return route.fulfill({ json: overview });
    });
    const { reads } = await stub(page, { accountNext: () => ACCOUNTS.healthy.report });
    await openHome(page);
    await expect(badge(page, "identity-ready")).toHaveAttribute("data-level", "ok");
    removed = true;
    await expect(async () => {
      await page.clock.fastForward(10_000);
      await expect(repoCard(page, "identity-ready")).toHaveCount(0, { timeout: 200 });
    }).toPass({ intervals: [200] });
    // Past reuse, the poll reads the repos still listed, and only those.
    reads.length = 0;
    await page.clock.fastForward(5 * 60_000);
    await pollUntil(page, () => reads.some((read) => read.kind === "repo" && read.name === "identity-invited"));
    expect(reads.some((read) => read.kind === "repo" && read.name === "identity-ready")).toBe(false);
  });

  test("a bot that is the user's own account gets the setup on item 1", async ({ page }) => {
    await stub(page, {
      accountNext: () => account({ state: "problem", findings: [finding("bot-is-user", "problem", `The bot account ${BOT} is your own account, so agents would have your access.`)] }),
      ready: () => false,
    });
    await page.goto("/?agent-identity=setup");
    const steps = card(page).locator("[data-slot=steps] > li");
    await expect(steps.first()).toContainText(`${BOT} is your own account; use a separate one`);
    await expect(card(page).locator("li[data-current=true] [data-slot=run]")).toHaveText("Open setup");
    await expect(steps.first()).toHaveAttribute("data-current", "true");
  });

  test("Settings' setup link opens the account card even with no GitHub repo listed", async ({ page }) => {
    // Home lists only repos that are not on GitHub.
    await page.route(/\/api\/home(\?.*)?$/, async (route) => {
      const overview = await (await route.fetch()).json();
      overview.repositories = overview.repositories.filter((repository) => !String(repository.repositoryId).startsWith("git:github.com/"));
      return route.fulfill({ json: overview });
    });
    await stub(page, { accountNext: () => ACCOUNTS["not-set-up"].report, ready: () => false });
    await page.goto("/?agent-identity=setup");
    await expect(card(page).locator("[data-slot=subject]")).toHaveText("Bot account (all repos)");
    // No repo folder to open the setup in, so the command is shown to run instead.
    await expect(card(page).locator("[data-slot=command-row]")).toBeVisible();
    await expect(card(page).locator("[data-slot=command]")).toContainText("roborepo github setup");
    await expect(offer(page)).toBeHidden();
    await expect(page).toHaveURL(/\/$/);
  });

  test("a repo the server turns down shows no badge", async ({ page }) => {
    await stub(page, { accountNext: () => ACCOUNTS.healthy.report, repoNext: () => ({ applies: false }) });
    // Badges start hidden, so wait until every repo's answer is in before checking they stay so.
    const answered = Promise.all(NAMES.map((name) => page.waitForResponse((response) => response.url().includes(`/${encodeURIComponent(`git:github.com/example/${name}`)}/agent-identity`))));
    await openHome(page);
    await answered;
    await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 100)));
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
