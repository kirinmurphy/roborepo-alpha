// The GitHub bot identity on Home. The bot account is one for every repo, so its state (signed in,
// package on, token expiry and scopes) shows once, in a banner above the repo list. Each GitHub repo
// card adds a one-line status for what is about that repo only: whether the bot was invited, has
// accepted, has no more than write access, and whether the branch rules stop it from merging. The
// page only reads status, asks the server to open `roborepo github setup` in a terminal, and asks
// it to turn the package on when that is the one step left; the token is typed at the terminal's
// hidden prompt and never passes through here.
import { portalFillSlots as fill, portalGetJson, portalPostJson, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import { supportsProtectionPanel } from "/portal/shared/protection-panel.js";

const ACCOUNT_URL = "/api/agent-identity";
const repoUrl = (repositoryId) => `/api/repositories/${encodeURIComponent(repositoryId)}/agent-identity`;
// Matches the server's cache, so re-rendering Home does not ask again sooner than it would answer.
const REUSE_MS = 5 * 60_000;
const FOCUS_THROTTLE_MS = 2_000;
const SETUP_COMMAND_PATTERN = /roborepo github setup/;
const TOKEN_FINDINGS = new Set(["expired", "expiring", "no-expiry", "fine-grained-token", "broad-scopes", "scopes-missing", "token-in-keychain"]);

// The bot identity is a GitHub feature: only listed GitHub repos show it. The server has the last
// word (`applies: false`), so a repo it turns down shows nothing either.
export function supportsAgentIdentity(repository) {
  return supportsProtectionPanel(repository) && String(repository.repositoryId).startsWith("git:github.com/");
}

let account = null; // { at, report }
let accountPending = null;
const reports = new Map(); // repositoryId -> { at, report }
const pending = new Map(); // repositoryId -> Promise
const lines = new Map(); // repositoryId -> Set of mounted line elements
const names = new Map(); // repositoryId -> display name
// Set while the user is away doing the setup (a terminal opened, or the command was shown): coming
// back to the window re-reads the account and these repos, and only these, past the cache.
let watchingAccount = false;
const watching = new Set();
let lastFocusRefresh = 0;
let banner = null;
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
  // Each repo's line reads the account on the server, so a changed account means new lines.
  if (before && (before.state !== report.state || before.botLogin !== report.botLogin || before.packageEnabled !== report.packageEnabled)) {
    for (const repositoryId of lines.keys()) load(repositoryId, { reread: true }).catch(() => {});
  }
  if (!describeAccount(report).offersSetup && !report.enableOffered) watchingAccount = false;
  banner?.render(report);
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
      if (!report.applies || !describeRepo(report).offersSetup) watching.delete(repositoryId);
      for (const line of lines.get(repositoryId) || []) renderLine(line, report);
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
      level = "warn";
      message = "Agents act on GitHub as you. A separate bot account lets GitHub itself refuse agent pushes to main and merges no one approved.";
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

// One repo's short label, level, sentence, fix, and whether the setup (run in that repo) is the
// next step. A repo waiting on the account says nothing: the banner covers it.
export function describeRepo(report) {
  if (report.account === "waiting") return { label: null, level: "muted", message: "", fix: null, offersSetup: false };
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
      label = REPO_LABELS[shown.id] || "needs attention";
      level = shown.id === "invite-pending" ? "warn" : "problem";
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

function accountFacts(report) {
  if (report.state === "not-set-up") return "";
  const facts = [];
  const login = report.botLogin || report.savedLogin;
  facts.push(login ? `bot ${login}` : "no bot signed in");
  facts.push(report.packageEnabled ? "package on" : "package off");
  if (report.scopes) facts.push(`token: ${report.scopes.join(", ") || "no scopes"}`);
  if (report.expiresAt) facts.push(`expires ${new Date(report.expiresAt).toLocaleDateString()}`);
  else if (report.botLogin) facts.push("no expiry");
  return facts.join(" · ");
}

// ---------------------------------------------------------------------------------------------
// Banner

// Renders the account banner above the repo list, once Home knows its repos. Hidden when no listed
// repo is on GitHub, since the account matters only there.
export function renderAgentIdentityBanner(mount, repositories) {
  if (!mount) return;
  const github = repositories.filter(supportsAgentIdentity);
  for (const repository of github) names.set(repository.repositoryId, repository.displayName || repository.repositoryId);
  if (github.length === 0) {
    mount.hidden = true;
    return;
  }
  banner ??= buildBanner(mount);
  banner.setRepositories(github);
  if (account) banner.render(account.report);
  loadAccount().catch((error) => banner.error(error.message));
}

function buildBanner(mount) {
  const node = tpl("tpl-agent-identity-banner");
  const slot = (name) => node.querySelector(`[data-slot="${name}"]`);
  let repositories = [];
  let copyFallback = false;
  let note = null;
  mount.replaceChildren(node);

  slot("details").addEventListener("click", () => openAccountCard());
  slot("enable").addEventListener("click", () => void turnOn(slot("enable"), (message) => { note = message; render(account?.report); }));
  slot("open-setup").addEventListener("click", async () => {
    const repositoryId = slot("repo-select").value;
    const result = await openSetup(slot("open-setup"), repositoryId);
    note = result.note;
    if (!result.launched) copyFallback = true;
    render(account?.report);
  });

  function render(report) {
    if (!report) return;
    mount.hidden = false;
    const view = describeAccount(report);
    fill(node, { state: view.label, facts: accountFacts(report), message: view.message });
    slot("state").dataset.level = view.level;
    node.dataset.level = view.level;
    // Healthy and quiet: one line, nothing to do.
    slot("message").hidden = view.level === "ok";
    slot("fix").hidden = !view.fix;
    slot("fix").textContent = view.fix ? `Fix: ${view.fix}` : "";
    const launchable = view.offersSetup && report.setupLaunch?.supported && repositories.length > 0;
    slot("enable").hidden = !view.enable;
    slot("open-setup").hidden = !launchable;
    slot("repo-pick").hidden = !launchable || repositories.length < 2;
    slot("actions").hidden = !view.enable && !launchable;
    const showCommand = view.offersSetup && (!launchable || copyFallback);
    slot("command-row").hidden = !showCommand;
    if (showCommand) {
      fill(node, { command: report.guide.command });
      slot("copy").copySource = report.guide.command;
      watchingAccount = true;
    }
    slot("note").hidden = !note;
    slot("note").textContent = note || "";
    slot("error").hidden = true;
  }

  return {
    render,
    error(message) {
      mount.hidden = false;
      slot("error").hidden = false;
      slot("error").textContent = `Agent GitHub account status unavailable: ${message}`;
    },
    setRepositories(list) {
      repositories = list;
      const select = slot("repo-select");
      const chosen = select.value;
      select.replaceChildren(...list.map((repository) => {
        const option = document.createElement("option");
        option.value = repository.repositoryId;
        option.textContent = repository.displayName || repository.repositoryId;
        return option;
      }));
      if (list.some((repository) => repository.repositoryId === chosen)) select.value = chosen;
    },
  };
}

// ---------------------------------------------------------------------------------------------
// Repo line

// Mounts the status line into a repo card's slot. Home rebuilds its cards on every refresh, so a
// known result renders at once and the read happens only when it is missing or old.
export function mountAgentIdentityLine(slot, repository) {
  if (!slot || !supportsAgentIdentity(repository)) return;
  names.set(repository.repositoryId, repository.displayName || repository.repositoryId);
  const line = tpl("tpl-agent-identity-line");
  line.hidden = true;
  line.querySelector("[data-slot=details]").addEventListener("click", () => openAgentIdentityCard(repository));
  slot.append(line);
  const set = lines.get(repository.repositoryId) || new Set();
  for (const old of set) if (!old.isConnected) set.delete(old);
  set.add(line);
  lines.set(repository.repositoryId, set);
  const known = reports.get(repository.repositoryId);
  if (known) renderLine(line, known.report);
  load(repository.repositoryId).catch(() => {});
}

function renderLine(line, report) {
  const view = report.applies ? describeRepo(report) : null;
  if (!view?.label) {
    line.hidden = true;
    return;
  }
  line.hidden = false;
  fill(line, { state: view.label, text: view.message });
  line.querySelector("[data-slot=state]").dataset.level = view.level;
}

// ---------------------------------------------------------------------------------------------
// Actions shared by the banner and the card

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
// Card: the account (from the banner) or one repo (from its line or menu)

function openAccountCard() {
  card ??= buildCard();
  void card.open({ kind: "account" });
}

export function openAgentIdentityCard(repository) {
  card ??= buildCard();
  void card.open({ kind: "repo", repositoryId: repository.repositoryId, name: repository.displayName || repository.repositoryId });
}

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
    const repositoryId = opening.kind === "repo" ? opening.repositoryId : [...lines.keys()][0];
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
    const view = target.kind === "account"
      ? describeAccount(accountReport)
      : repoReport.applies
        ? repoReport.account === "waiting"
          ? { ...describeAccount(accountReport), label: "account first", level: describeAccount(accountReport).level }
          : describeRepo(repoReport)
        : { label: "not on GitHub", level: "muted", message: "This repo's remote is not on github.com, so the bot account does not apply.", fix: null, offersSetup: false };
    fill(dialog, { subject: target.kind === "account" ? "Bot account (all repos)" : target.name, state: view.label, message: view.message || "The bot can work here." });
    slot("state").dataset.level = view.level;
    slot("fix").hidden = !view.fix;
    slot("fix").textContent = view.fix ? `Fix: ${view.fix}` : "";

    const checks = target.kind === "account" ? accountChecks(accountReport) : repoReport.applies ? repoChecks(accountReport, repoReport) : [];
    slot("checks").hidden = checks.length === 0;
    slot("checks").replaceChildren(...checks.map((check) => stepItem("tpl-agent-identity-check", check)));

    const ownerMessage = repoReport?.ownerMessage || null;
    slot("owner").hidden = !ownerMessage;
    slot("owner-message").textContent = ownerMessage || "";
    slot("owner-copy").copySource = ownerMessage || "";

    // The github.com steps are the account's; a repo card shows them only while the account is
    // what is in the way.
    const guide = accountReport.guide;
    const accountView = describeAccount(accountReport);
    const showGuide = Boolean(guide) && (target.kind === "account" || repoReport?.account === "waiting") && accountView.offersSetup;
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

    const offersSetup = view.offersSetup || (repoReport?.account === "waiting" && accountView.offersSetup);
    const enable = (target.kind === "account" || repoReport?.account === "waiting") && accountView.enable;
    const setupRepo = target.kind === "repo" ? target.repositoryId : [...lines.keys()][0];
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

// What the account card confirms, one line each.
function accountChecks(report) {
  if (report.state === "not-set-up") return [];
  const login = report.botLogin || report.savedLogin;
  const findings = report.findings || [];
  const has = (id) => findings.some((entry) => entry.id === id);
  return [
    { label: "Bot account", note: login ? `${login}${has("bot-is-user") ? " is your own account" : ""}` : "none signed in", done: Boolean(report.botLogin) && !has("bot-is-user") },
    { label: "Token", note: tokenNote(report), done: Boolean(report.botLogin) && !findings.some((entry) => TOKEN_FINDINGS.has(entry.id)) },
    { label: "Package", note: report.packageEnabled ? "on: agent shells use the bot" : "off: agents still act as you", done: report.packageEnabled },
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

// What a repo card confirms: the account (shared), the bot's place in this repo, and the rules.
function repoChecks(accountReport, report) {
  const accountOk = accountReport.state === "healthy";
  const accountLine = { label: "Bot account", note: accountOk ? `${accountReport.botLogin}, shared by every repo` : "needs attention; see the banner on Home", done: accountOk };
  if (report.account === "waiting") return [accountLine];
  const has = (id) => report.findings.some((entry) => entry.id === id);
  const accessKnown = report.state !== "unavailable" || report.findings.length > 0;
  const invite = has("invite-pending") ? "invited; the bot has not accepted yet"
    : has("not-collaborator") ? "not invited"
      : has("bot-is-admin") ? "accepted, but the bot is an admin" : "accepted, with write access";
  const rules = has("protection-unverified") ? "applied, but who may bypass them cannot be seen"
    : has("protection") ? "missing" : has("protection-unchecked") ? "could not be read" : "approval required to merge; main and plans protected";
  return [
    accountLine,
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
