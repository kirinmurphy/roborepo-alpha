// The GitHub bot identity on Home. While the package is off, Home offers the setup once, in an info
// prompt above the repo list that "No thanks" hides for good. Once the package is on, each GitHub
// repo's title carries an "agent bot" badge (green when agents can work there, red when something
// is in the way), and the badge opens a card with everything about the bot in that repo: the
// account, its token, the bot's invitation, the branch rules, and the steps that remain. The page
// only reads status, asks the server to open `roborepo github setup` in a terminal, and asks it to
// turn the package on when that is the one step left; the token is typed at the terminal's hidden
// prompt and never passes through here.
import { portalFillSlots as fill, portalGetJson, portalPostJson, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import { supportsProtectionPanel } from "/portal/shared/protection-panel.js";

const ACCOUNT_URL = "/api/agent-identity";
const repoUrl = (repositoryId) => `/api/repositories/${encodeURIComponent(repositoryId)}/agent-identity`;
// Matches the server's cache, so re-rendering Home does not ask again sooner than it would answer.
const REUSE_MS = 5 * 60_000;
const FOCUS_THROTTLE_MS = 2_000;
const SETUP_COMMAND_PATTERN = /roborepo github setup/;
const TOKEN_FINDINGS = new Set(["expired", "expiring", "no-expiry", "fine-grained-token", "broad-scopes", "scopes-missing", "token-in-keychain"]);
const LEVEL_RANK = { ok: 0, muted: 1, warn: 2, problem: 3 };

// The bot identity is a GitHub feature: only listed GitHub repos show it. The server has the last
// word (`applies: false`), so a repo it turns down shows nothing either.
export function supportsAgentIdentity(repository) {
  return supportsProtectionPanel(repository) && String(repository.repositoryId).startsWith("git:github.com/");
}

let account = null; // { at, report }
let accountPending = null;
const reports = new Map(); // repositoryId -> { at, report }
const pending = new Map(); // repositoryId -> Promise
const badges = new Map(); // repositoryId -> Set of mounted badge elements
const names = new Map(); // repositoryId -> display name
let githubRepositories = [];
// Set while the user is away doing the setup (a terminal opened, or the command was shown): coming
// back to the window re-reads the account and these repos, and only these, past the cache.
let watchingAccount = false;
const watching = new Set();
let lastFocusRefresh = 0;
let offer = null;
let card = null;

// ---------------------------------------------------------------------------------------------
// Reads

function loadAccount({ fresh = false } = {}) {
  if (!fresh && account && Date.now() - account.at < REUSE_MS) return Promise.resolve(account.report);
  if (!fresh && accountPending) return accountPending;
  const request = portalGetJson(`${ACCOUNT_URL}${fresh ? "?fresh=1" : ""}`)
    .then((report) => {
      showAccount(report);
      return report;
    })
    .finally(() => { if (accountPending === request) accountPending = null; });
  accountPending = request;
  return request;
}

function showAccount(report) {
  const before = account?.report;
  account = { at: Date.now(), report };
  // Each repo's read depends on the account on the server, so a changed account means new reads.
  const changed = before && (before.state !== report.state || before.botLogin !== report.botLogin || before.packageEnabled !== report.packageEnabled);
  for (const repositoryId of badges.keys()) {
    if (report.packageEnabled && (changed || !reports.has(repositoryId))) load(repositoryId, { reread: true }).catch(() => {});
    renderBadges(repositoryId);
  }
  if (!describeAccount(report).offersSetup && !report.enableOffered) watchingAccount = false;
  offer?.render(report);
  if (card?.showing("account")) card.render();
}

// `reread` skips only this page's copy; `fresh` also skips the server's cache.
function load(repositoryId, { fresh = false, reread = false } = {}) {
  const known = reports.get(repositoryId);
  if (!fresh && !reread && known && Date.now() - known.at < REUSE_MS) return Promise.resolve(known.report);
  if (!fresh && !reread && pending.has(repositoryId)) return pending.get(repositoryId);
  const request = portalGetJson(`${repoUrl(repositoryId)}${fresh ? "?fresh=1" : ""}`)
    .then((report) => {
      reports.set(repositoryId, { at: Date.now(), report });
      if (!report.applies || !repoView(account?.report, report).offersSetup) watching.delete(repositoryId);
      renderBadges(repositoryId);
      if (card?.showing(repositoryId)) card.render();
      return report;
    })
    .finally(() => { if (pending.get(repositoryId) === request) pending.delete(repositoryId); });
  pending.set(repositoryId, request);
  return request;
}

// ---------------------------------------------------------------------------------------------
// What each report says

const shownFinding = (findings = []) => findings.find((entry) => entry.severity === "problem")
  || findings.find((entry) => entry.severity === "unverified")
  || findings.find((entry) => entry.severity === "warn" || entry.severity === "unchecked")
  || null;

// The account's short state label, how worried to look, the sentence to show, the fix of the
// finding shown, whether the next step is the terminal setup, and whether it is turning the
// package on.
export function describeAccount(report) {
  const findings = report.findings || [];
  const shown = shownFinding(findings);
  const renew = findings.some((entry) => entry.id === "expiring" || entry.id === "no-expiry");
  const enable = report.enableOffered === true;
  let label;
  let level;
  let message;
  switch (report.state) {
    case "not-set-up":
      label = "not set up";
      // With the package on and no bot, agents cannot use GitHub at all; with it off, this is only
      // something on offer.
      level = report.packageEnabled ? "problem" : "muted";
      message = report.packageEnabled
        ? "The package is on, but no bot account is set up, so agents cannot push or open pull requests."
        : "Agents use your GitHub account today. With a bot account of their own, GitHub itself refuses their pushes to main and merges no one approved.";
      break;
    case "healthy":
      label = renew ? "renew soon" : "on";
      level = shown ? "warn" : "ok";
      message = shown ? shown.message : `Agents act on GitHub as ${report.botLogin}.`;
      break;
    case "problem":
      if (enable) {
        label = "off";
        level = "warn";
        message = `${report.botLogin} is ready, but the package that switches agents to it is off, so agents still act as you.`;
      } else {
        // The label names the finding shown, so it never says "expired" over another problem.
        label = shown.id === "expired" ? "token expired" : "needs attention";
        level = "problem";
        message = shown.message;
      }
      break;
    default:
      label = "not checked";
      level = "muted";
      message = shown ? shown.message : `The status could not be checked: ${report.reason}.`;
  }
  const fix = enable ? null : shown?.fix || null;
  const offersSetup = !enable && (report.state === "not-set-up" || SETUP_COMMAND_PATTERN.test(fix || ""));
  return { label, level, message, fix, offersSetup, enable };
}

const REPO_LABELS = {
  "invite-pending": "invite pending",
  "not-collaborator": "not invited",
  "bot-is-admin": "too much access",
  protection: "branch rules missing",
};

// What is about one repo only: its short label, level, sentence, fix, and whether the setup (run
// in that repo) is the next step.
export function describeRepo(report) {
  const shown = shownFinding(report.findings);
  let label;
  let level;
  let message;
  switch (report.state) {
    case "healthy":
      label = "ready";
      level = "ok";
      message = "";
      break;
    case "unverified":
      label = "rules unverified";
      level = "warn";
      message = shown.message;
      break;
    case "problem":
      // A pending invite still stops every push, so it is as red as a missing one.
      label = REPO_LABELS[shown.id] || "needs attention";
      level = "problem";
      message = shown.message;
      break;
    default:
      label = "not checked";
      level = "muted";
      message = shown ? shown.message : `The status could not be checked: ${report.reason}.`;
  }
  const fix = shown?.fix || null;
  return { label, level, message, fix, offersSetup: !shown?.owner && SETUP_COMMAND_PATTERN.test(fix || "") };
}

// The bot in one repo, account included: the account's state while it is what stands in the way
// (or is the worse of the two), otherwise the repo's own.
export function repoView(accountReport, report) {
  if (!report.applies) return { label: "not on GitHub", level: "muted", message: "This repo's remote is not on github.com, so the bot account does not apply.", fix: null, offersSetup: false };
  const accountView = accountReport ? describeAccount(accountReport) : null;
  if (report.account === "waiting") return accountView || { label: "checking", level: "muted", message: "", fix: null, offersSetup: false };
  const view = describeRepo(report);
  return accountView && LEVEL_RANK[accountView.level] > LEVEL_RANK[view.level] ? accountView : view;
}

// ---------------------------------------------------------------------------------------------
// The setup offer above the repo list, while the package is off

// Renders the offer once Home knows its repos. Nothing shows when no listed repo is on GitHub, when
// the package is on (the badges take over), or once the user said "No thanks".
export function renderAgentIdentityOffer(mount, repositories) {
  if (!mount) return;
  githubRepositories = repositories.filter(supportsAgentIdentity);
  for (const repository of githubRepositories) names.set(repository.repositoryId, repository.displayName || repository.repositoryId);
  if (githubRepositories.length === 0) {
    mount.hidden = true;
    return;
  }
  offer ??= buildOffer(mount);
  if (account) offer.render(account.report);
  // An offer, not a warning: a failed read just leaves it out.
  loadAccount().catch(() => { mount.hidden = true; });
}

function buildOffer(mount) {
  const node = tpl("tpl-agent-identity-offer");
  const slot = (name) => node.querySelector(`[data-slot="${name}"]`);
  let declined = false;
  let note = null;
  mount.replaceChildren(node);

  slot("setup").addEventListener("click", () => openAccountCard());
  slot("enable").addEventListener("click", () => void turnOn(slot("enable"), (message) => { note = message; render(account?.report); }));
  slot("dismiss").addEventListener("click", async () => {
    slot("dismiss").disabled = true;
    try {
      await portalPostJson(`${ACCOUNT_URL}/dismiss-offer`, {});
      declined = true;
      note = null;
    } catch (error) {
      note = `Could not save that: ${error.message}`;
    } finally {
      slot("dismiss").disabled = false;
    }
    render(account?.report);
  });
  slot("close").addEventListener("click", () => { mount.hidden = true; });

  function render(report) {
    if (!report) return;
    // Just declined: say where to find it later, until the page reloads.
    if (declined) {
      mount.hidden = false;
      slot("offer").hidden = true;
      slot("declined").hidden = false;
      return;
    }
    if (report.packageEnabled || report.offerDismissed) {
      mount.hidden = true;
      return;
    }
    mount.hidden = false;
    slot("offer").hidden = false;
    slot("declined").hidden = true;
    const ready = report.enableOffered === true;
    fill(node, {
      message: ready
        ? `Your agents' bot account, ${report.botLogin}, is set up. Turn the package on and agents use it instead of your account.`
        : "Agents push and open pull requests as you. Give them their own GitHub bot account, and GitHub itself refuses their pushes to main and merges no one approved.",
    });
    slot("enable").hidden = !ready;
    slot("setup").hidden = ready;
    slot("note").hidden = !note;
    slot("note").textContent = note || "";
  }

  return { render };
}

// ---------------------------------------------------------------------------------------------
// The badge beside a repo's GitHub link, while the package is on

// Mounts the badge into a repo card's title. Home rebuilds its cards on every refresh, so a known
// result renders at once and the read happens only when it is missing or old.
export function mountAgentIdentityBadge(slot, repository) {
  if (!slot || !supportsAgentIdentity(repository)) return;
  const { repositoryId } = repository;
  names.set(repositoryId, repository.displayName || repositoryId);
  const badge = tpl("tpl-agent-identity-badge");
  badge.hidden = true;
  badge.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    openAgentIdentityCard(repository);
  });
  slot.append(badge);
  const set = badges.get(repositoryId) || new Set();
  for (const old of set) if (!old.isConnected) set.delete(old);
  set.add(badge);
  badges.set(repositoryId, set);
  renderBadge(badge, repositoryId);
  // The repo is read only once the account says the package is on: with it off there is no badge.
  loadAccount().then((report) => (report.packageEnabled ? load(repositoryId) : null)).catch(() => {});
}

function renderBadges(repositoryId) {
  for (const badge of badges.get(repositoryId) || []) renderBadge(badge, repositoryId);
}

function renderBadge(badge, repositoryId) {
  const report = reports.get(repositoryId)?.report;
  if (!account?.report.packageEnabled || !report?.applies) {
    badge.hidden = true;
    return;
  }
  const view = repoView(account.report, report);
  badge.hidden = false;
  badge.dataset.level = view.level;
  badge.title = `Agent bot: ${view.label}`;
  badge.setAttribute("aria-label", `Agent bot: ${view.label}. Show details`);
}

// ---------------------------------------------------------------------------------------------
// Actions shared by the offer and the card

async function turnOn(button, onNote) {
  button.disabled = true;
  try {
    const result = await portalPostJson(`${ACCOUNT_URL}/enable`, {});
    if (result.account) showAccount(result.account);
    onNote(result.enabled ? "Agents act as the bot in new agent sessions; ones already open keep acting as you until restarted." : result.message);
  } catch (error) {
    onNote(error.message);
  } finally {
    button.disabled = false;
  }
}

async function openSetup(button, repositoryId) {
  button.disabled = true;
  watchingAccount = true;
  watching.add(repositoryId);
  try {
    const result = await portalPostJson(`${repoUrl(repositoryId)}/setup`, {});
    return {
      launched: result.launched,
      note: result.launched
        ? `A terminal opened running roborepo github setup in ${names.get(repositoryId) || "the repo"}'s folder. Finish it there; this page updates when you come back.`
        : launchFailureNote(result),
    };
  } catch (error) {
    return { launched: false, note: error.message };
  } finally {
    button.disabled = false;
  }
}

const LAUNCH_REASONS = {
  unsupported_platform: "This computer cannot open the setup from the portal.",
  no_checkout: "No checkout of this repo is recorded on this computer.",
  no_folder: "This repo's folder could not be found.",
  no_executable: "The portal could not find the program to run.",
  launch_failed: "The terminal did not open.",
  not_github: "This repo is not on github.com.",
};

function launchFailureNote(result) {
  const base = LAUNCH_REASONS[result.reason] || "The terminal did not open.";
  return `${base} Run the command below in your own terminal instead.${result.error ? ` (${result.error})` : ""}`;
}

// ---------------------------------------------------------------------------------------------
// Card: the account (from the offer) or one repo (from its badge or menu). Each says everything
// the user needs on its own; neither points at the other.

function openAccountCard() {
  card ??= buildCard();
  void card.open({ kind: "account" });
}

export function openAgentIdentityCard(repository) {
  card ??= buildCard();
  void card.open({ kind: "repo", repositoryId: repository.repositoryId, name: repository.displayName || repository.repositoryId });
}

const firstGithubRepository = () => githubRepositories[0]?.repositoryId || [...badges.keys()][0] || null;

function buildCard() {
  const dialog = document.getElementById("agent-identity-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot="${name}"]`);
  let target = null;

  slot("close").addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
  slot("recheck").addEventListener("click", () => refresh({ fresh: true }));
  slot("enable").addEventListener("click", () => void turnOn(slot("enable"), (message) => { if (target) target.note = message; render(); }));
  slot("open-setup").addEventListener("click", async () => {
    const opening = target;
    const repositoryId = opening.kind === "repo" ? opening.repositoryId : firstGithubRepository();
    const result = await openSetup(slot("open-setup"), repositoryId);
    if (target !== opening) return;
    opening.note = result.note;
    if (!result.launched) opening.copyFallback = true;
    render();
  });

  function showError(message) {
    slot("error").hidden = !message;
    slot("error").textContent = message || "";
  }

  async function refresh({ fresh }) {
    const opening = target;
    showError(null);
    try {
      await loadAccount({ fresh });
      if (opening.kind === "repo") await load(opening.repositoryId, { fresh });
      if (target === opening) render();
    } catch (error) {
      if (target === opening) showError(error.message);
    }
  }

  function render() {
    if (!target || !account) return;
    const accountReport = account.report;
    const repoReport = target.kind === "repo" ? reports.get(target.repositoryId)?.report : null;
    if (target.kind === "repo" && !repoReport) return;
    const accountView = describeAccount(accountReport);
    const view = target.kind === "account" ? accountView : repoView(accountReport, repoReport);
    fill(dialog, { subject: target.kind === "account" ? "Bot account (all repos)" : target.name, state: view.label, message: view.message || "Agents can push and open pull requests here as the bot." });
    slot("state").dataset.level = view.level;
    slot("fix").hidden = !view.fix;
    slot("fix").textContent = view.fix ? `Fix: ${view.fix}` : "";

    const checks = target.kind === "repo" && !repoReport.applies ? [] : [
      ...accountChecks(accountReport),
      ...(target.kind === "repo" && repoReport.account !== "waiting" ? repoChecks(repoReport) : []),
    ];
    slot("checks").hidden = checks.length === 0;
    slot("checks").replaceChildren(...checks.map((check) => stepItem("tpl-agent-identity-check", check)));

    const ownerMessage = repoReport?.ownerMessage || null;
    slot("owner").hidden = !ownerMessage;
    slot("owner-message").textContent = ownerMessage || "";
    slot("owner-copy").copySource = ownerMessage || "";

    // The github.com steps belong to the account, so every card shows them while the account needs
    // the setup.
    const guide = accountReport.guide;
    const applies = target.kind === "account" || repoReport.applies;
    const showGuide = Boolean(guide) && applies && accountView.offersSetup;
    slot("guide").hidden = !showGuide;
    if (showGuide) {
      slot("guide-lead").textContent = guide.lead;
      slot("steps").replaceChildren(...guideSteps(accountReport, guide).map((step) => {
        const item = stepItem("tpl-agent-identity-step", step);
        fill(item, { url: step.url });
        item.querySelector("[data-slot=copy]").copySource = step.url;
        return item;
      }));
      fill(dialog, { "guide-expiry": `Token expiry: ${guide.expiry}`, "token-warning": guide.tokenWarning });
    }

    const offersSetup = applies && (view.offersSetup || accountView.offersSetup);
    const enable = applies && accountView.enable;
    const setupRepo = target.kind === "repo" ? target.repositoryId : firstGithubRepository();
    const launchable = offersSetup && Boolean(setupRepo) && (target.kind === "repo" ? repoReport.setupLaunch?.supported : accountReport.setupLaunch?.supported);
    slot("enable").hidden = !enable;
    slot("open-setup").hidden = !launchable;
    const showCommand = offersSetup && (!launchable || target.copyFallback);
    slot("command-row").hidden = !showCommand;
    if (showCommand && guide) {
      fill(dialog, { command: guide.command });
      slot("copy").copySource = guide.command;
      if (target.kind === "repo") watching.add(target.repositoryId);
      watchingAccount = true;
    }
    const note = target.note || (offersSetup && !launchable && repoReport?.setupLaunch?.reason ? repoReport.setupLaunch.reason : null);
    slot("launch-note").hidden = !note;
    slot("launch-note").textContent = note || "";
  }

  return {
    showing: (key) => dialog.open && Boolean(target) && (key === "account" ? true : target.repositoryId === key),
    render,
    async open(next) {
      target = { ...next, copyFallback: false, note: null };
      fill(dialog, { subject: next.kind === "account" ? "Bot account (all repos)" : next.name, state: "checking", message: "Reading the bot account's status from GitHub…" });
      slot("state").dataset.level = "muted";
      for (const name of ["fix", "checks", "owner", "command-row", "launch-note", "guide", "open-setup", "enable"]) slot(name).hidden = true;
      showError(null);
      if (!dialog.open) dialog.showModal();
      await refresh({ fresh: false });
    },
  };
}

function stepItem(template, step) {
  const item = fill(tpl(template), { label: step.label, note: step.note || "" });
  item.dataset.done = String(step.done);
  item.querySelector("[data-slot=mark]").textContent = step.done ? "✓" : "";
  if (step.done) item.querySelector("[data-slot=mark]").setAttribute("aria-label", "Done");
  return item;
}

// The github.com steps, each marked done when the status already shows it: the account exists once
// a bot is signed in, and the token is done while GitHub accepts it and nothing is wrong with it.
// Renewing replaces the token step when there is a token to renew.
export function guideSteps(report, guide) {
  const findings = report.findings || [];
  const tokenTrouble = findings.some((entry) => TOKEN_FINDINGS.has(entry.id));
  const accountDone = Boolean(report.signedIn || report.savedLogin);
  const tokenDone = Boolean(report.botLogin) && !tokenTrouble;
  const renewing = accountDone && (tokenTrouble || !report.botLogin);
  return guide.steps
    .filter((step) => (step.id === "renew" ? renewing : step.id === "token" ? !renewing : true))
    .map((step) => ({ ...step, done: step.id === "account" ? accountDone : step.id === "token" ? tokenDone : false }));
}

// What the status confirms about the account, one line each. The package line shows only while it
// is off: a card reached from a badge already means it is on.
function accountChecks(report) {
  if (report.state === "not-set-up") return [];
  const login = report.botLogin || report.savedLogin;
  const findings = report.findings || [];
  const has = (id) => findings.some((entry) => entry.id === id);
  return [
    { label: "Bot account", note: login ? `${login}${has("bot-is-user") ? " is your own account" : ", shared by every repo"}` : "none signed in", done: Boolean(report.botLogin) && !has("bot-is-user") },
    { label: "Token", note: tokenNote(report), done: Boolean(report.botLogin) && !findings.some((entry) => TOKEN_FINDINGS.has(entry.id)) },
    ...(report.packageEnabled ? [] : [{ label: "Package", note: "off: agents still act as you", done: false }]),
  ];
}

function tokenNote(report) {
  const findings = report.findings || [];
  const trouble = findings.find((entry) => TOKEN_FINDINGS.has(entry.id));
  if (!report.botLogin) return trouble ? trouble.message : "GitHub did not accept it";
  const parts = [report.scopes ? `scopes ${report.scopes.join(", ")}` : "fine-grained (no scope list)"];
  parts.push(report.expiresAt ? `expires ${new Date(report.expiresAt).toLocaleDateString()}` : "no expiry date");
  return trouble ? `${parts.join(", ")}: ${trouble.message}` : parts.join(", ");
}

// What the status confirms in one repo: the bot's place there, and the branch rules.
function repoChecks(report) {
  const has = (id) => report.findings.some((entry) => entry.id === id);
  const accessKnown = report.state !== "unavailable" || report.findings.length > 0;
  const invite = has("invite-pending") ? "invited; the bot has not accepted yet"
    : has("not-collaborator") ? "not invited"
      : has("bot-is-admin") ? "accepted, but the bot is an admin" : "accepted, with write access";
  const rules = has("protection-unverified") ? "applied, but who may bypass them cannot be seen"
    : has("protection") ? "missing" : has("protection-unchecked") ? "could not be read" : "approval required to merge; main and plans protected";
  return [
    { label: "Invitation", note: accessKnown ? invite : "not checked", done: accessKnown && !has("invite-pending") && !has("not-collaborator") && !has("bot-is-admin") },
    { label: "Branch rules", note: accessKnown ? rules : "not checked", done: accessKnown && !["protection", "protection-unverified", "protection-unchecked"].some(has) },
  ];
}

// ---------------------------------------------------------------------------------------------

// Coming back to the window after the setup: re-read the account and only the repos being set up.
function refreshOnReturn() {
  if (document.visibilityState !== "visible" || (!watchingAccount && watching.size === 0)) return;
  if (Date.now() - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
  lastFocusRefresh = Date.now();
  if (watchingAccount) loadAccount({ fresh: true }).catch(() => {});
  for (const repositoryId of watching) load(repositoryId, { fresh: true }).catch(() => {});
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
