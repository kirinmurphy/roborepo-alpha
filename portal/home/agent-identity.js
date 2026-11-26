// The GitHub bot identity on Home. While the package is off, Home offers the setup once, in an info
// prompt above the repo list that "No thanks" hides for good. Once the package is on, each GitHub
// repo's title carries an "agent bot" badge (green when agents can work there, red when something
// is in the way), and the badge opens a card listing, in setup order, the bot account, its token,
// agents using it, the bot's invitation to that repo, and the branch rules. Settings owns the on/off
// switch and links here to set it up. The card shows one action at a time, on the first open item:
// the server turns the package on, applies the config, invites the bot, or protects branches; the
// login and token go through `roborepo github setup`, which the server opens in a terminal, so the
// token is typed at its hidden prompt and never passes through here.
import { portalFillSlots as fill, portalGetJson, portalPostJson, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import { applyProtection, supportsProtectionPanel } from "/portal/shared/protection-panel.js";

const ACCOUNT_URL = "/api/agent-identity";
const repoUrl = (repositoryId) => `/api/repositories/${encodeURIComponent(repositoryId)}/agent-identity`;
// Matches the server's cache of GitHub's answers, so re-rendering Home does not ask again sooner
// than it would answer. The account is still re-read on each of Home's polls (`pollAgentIdentity`),
// since the server re-checks the local facts, such as the package being on, on every request.
const REUSE_MS = 5 * 60_000;
const FOCUS_THROTTLE_MS = 2_000;
const SETUP_COMMAND_PATTERN = /roborepo github setup/;
const TOKEN_FINDINGS = new Set(["expired", "expiring", "no-expiry", "fine-grained-token", "broad-scopes", "scopes-missing", "token-in-keychain"]);
const LEVEL_RANK = { ok: 0, muted: 1, warn: 2, problem: 3 };
// How long the card shows "All set" after the last open item is checked off, before it closes.
const COMPLETE_CLOSE_MS = 5_000;

// The bot identity is a GitHub feature: only listed GitHub repos show it. The server has the last
// word (`applies: false`), so a repo it turns down shows nothing either.
export function supportsAgentIdentity(repository) {
  return supportsProtectionPanel(repository) && String(repository.repositoryId).startsWith("git:github.com/");
}

let account = null; // { at, report }
let accountPending = null;
const reports = new Map(); // repositoryId -> { at, report }
const pending = new Map(); // repositoryId -> { request, fresh }
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

// `reread` skips only this page's copy; `fresh` also skips the server's cache. Only the latest read
// started is shown: an older one answering last would put back the status the fresh read replaced.
function loadAccount({ fresh = false, reread = false } = {}) {
  if (!fresh && !reread && account && Date.now() - account.at < REUSE_MS) return Promise.resolve(account.report);
  if (!fresh && accountPending) return accountPending;
  const request = portalGetJson(`${ACCOUNT_URL}${fresh ? "?fresh=1" : ""}`)
    .then((report) => {
      if (accountPending !== request) return account?.report ?? report;
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
  // Home's poll mostly gets the same answer back; leave the page, and an open card, as they are.
  if (before && JSON.stringify(before) === JSON.stringify(report)) return;
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

// `reread` skips only this page's copy; `fresh` also skips the server's cache. As for the account,
// only the latest read started is shown, and a reread waits on a fresh read in flight rather than
// replacing it.
function load(repositoryId, { fresh = false, reread = false } = {}) {
  const known = reports.get(repositoryId);
  if (!fresh && !reread && known && Date.now() - known.at < REUSE_MS) return Promise.resolve(known.report);
  const inFlight = pending.get(repositoryId);
  if (!fresh && inFlight && (!reread || inFlight.fresh)) return inFlight.request;
  const request = portalGetJson(`${repoUrl(repositoryId)}${fresh ? "?fresh=1" : ""}`)
    .then((report) => (pending.get(repositoryId)?.request === request ? showRepo(repositoryId, report) : reports.get(repositoryId)?.report ?? report))
    .finally(() => { if (pending.get(repositoryId)?.request === request) pending.delete(repositoryId); });
  pending.set(repositoryId, { request, fresh });
  return request;
}

function showRepo(repositoryId, report) {
  reports.set(repositoryId, { at: Date.now(), report });
  if (!report.applies || !repoView(account?.report, report).offersSetup) watching.delete(repositoryId);
  renderBadges(repositoryId);
  if (card?.showing(repositoryId)) card.render();
  return report;
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
        ? "Agents are set to use a bot account, but none is set up, so they cannot push or open pull requests."
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
        message = `${report.botLogin} is ready, but agents still act as you.`;
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
  return { label, level, message, fix, offersSetup, enable, findingId: shown?.id || null };
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
// The banner above the repo list: the setup offer while the package is off, and a warning while it
// is on but the bot cannot sign in

// Renders the banner once Home knows its repos. Nothing shows when no listed repo is on GitHub, when
// the package is on and the bot works (the badges take over), or, for the offer, once the user said
// "No thanks". The warning has no "No thanks": hiding it would hide that agents' GitHub work fails.
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
  openCardFromLink();
  // A failed read just leaves the banner out; the badges and Settings say the account is unread.
  loadAccount().catch(() => { mount.hidden = true; });
}

// Called on each of Home's polls: re-reads the account so a change made outside the page (the
// package turned on or off in a terminal, the setup finishing) shows within one poll. A changed
// account re-reads the repos too (`showAccount`). A first read that failed is retried here too.
export function pollAgentIdentity() {
  if (githubRepositories.length === 0) return;
  loadAccount({ reread: true }).catch(() => {});
}

// Settings' "Set it up" links to Home with ?agent-identity=setup, since the setup runs in a repo's
// folder and Home knows the repos. The parameter is removed once used, so a reload does not reopen it.
function openCardFromLink() {
  const url = new URL(window.location.href);
  if (url.searchParams.get("agent-identity") !== "setup") return;
  url.searchParams.delete("agent-identity");
  window.history.replaceState(null, "", `${url.pathname}${url.search}${url.hash}`);
  openAccountCard();
}

function buildOffer(mount) {
  const node = tpl("tpl-agent-identity-offer");
  const slot = (name) => node.querySelector(`[data-slot="${name}"]`);
  let declined = false;
  let note = null;
  let updated = null;
  mount.replaceChildren(node);

  slot("setup").addEventListener("click", () => openAccountCard());
  slot("fix").addEventListener("click", () => openAccountCard());
  slot("enable").addEventListener("click", () => void turnOn(slot("enable"), (message) => { note = message; render(account?.report); }));
  slot("update").addEventListener("click", () => void updateConfig(slot("update"), (message, applied) => {
    if (applied) updated = message;
    else note = message;
    render(account?.report);
  }));
  slot("done").addEventListener("click", () => { updated = null; mount.hidden = true; });
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
    const view = describeAccount(report);
    const broken = report.packageEnabled && view.level === "problem";
    // Agents' pushes still going out as the user is fixed by applying RoboRepo's config, which the
    // portal can run itself.
    const updatable = broken && view.findingId === "git-not-routed";
    node.setAttribute("variant", broken ? "alert" : "info");
    slot("fix").hidden = !broken || updatable;
    slot("update").hidden = !updatable;
    slot("done").hidden = true;
    if (broken) {
      mount.hidden = false;
      slot("offer").hidden = false;
      slot("declined").hidden = true;
      slot("enable").hidden = true;
      slot("setup").hidden = true;
      slot("dismiss").hidden = true;
      // A failed Update now says why under the message.
      slot("note").hidden = !note;
      slot("note").textContent = note || "";
      // What is wrong, then what to do. With no bot at all the account's sentence already says it.
      fill(node, { message: report.state === "not-set-up" || updatable ? view.message : [view.message, view.fix].filter(Boolean).join(" ") });
      return;
    }
    // Just updated from here: say what that means for sessions already open, until OK.
    if (report.packageEnabled && updated) {
      mount.hidden = false;
      slot("offer").hidden = false;
      slot("declined").hidden = true;
      for (const name of ["enable", "setup", "dismiss", "note"]) slot(name).hidden = true;
      slot("done").hidden = false;
      fill(node, { message: updated });
      return;
    }
    slot("dismiss").hidden = false;
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
    // A bot that exists but cannot be used yet (say its token is in the keychain): name it rather
    // than offer to create one. Nothing fails meanwhile, since agents still act as the user.
    const bot = report.botLogin || report.savedLogin;
    const unfinished = !ready && report.state === "problem" && bot;
    fill(node, {
      message: ready
        ? `Your agents' bot account, ${report.botLogin}, is set up. Turn it on and agents use it instead of your account.`
        : unfinished
          ? `Your agents' bot account, ${bot}, needs attention before agents can use it. Until then, agents act on GitHub as you.`
          : "Currently, agents push and open pull requests as you. Give them their own GitHub bot account to prevent admin abilities such as pushing to main and merging PRs no one approved.",
    });
    slot("enable").hidden = !ready;
    slot("setup").hidden = ready || unfinished;
    slot("fix").hidden = !unfinished;
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
  await busy(button, "Turning on…", async () => {
    try {
      const result = await portalPostJson(`${ACCOUNT_URL}/enable`, {});
      if (result.account) showAccount(result.account);
      onNote(result.enabled ? "Agents act as the bot in new agent sessions; ones already open keep acting as you until restarted." : result.message);
    } catch (error) {
      onNote(error.message);
    }
  });
}

// Applies RoboRepo's config so agents' Git uses the bot. Takes a few seconds: the button says so.
async function updateConfig(button, onNote) {
  await busy(button, "Updating…", async () => {
    try {
      const result = await portalPostJson(`${ACCOUNT_URL}/update`, {});
      if (result.account) showAccount(result.account);
      onNote(result.applied
        ? "Updated. New agent sessions push as the bot; ones already open still push as you until restarted."
        : result.message || null, Boolean(result.applied));
    } catch (error) {
      onNote(error.message);
    }
  });
}

async function openSetup(button, repositoryId) {
  watchingAccount = true;
  watching.add(repositoryId);
  return busy(button, "Opening…", async () => {
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
    }
  });
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
// Card: the account (from the offer or Settings) or one repo (from its badge or menu). One numbered
// list in setup order, so the first unchecked item is where to start; an item that needs a page on
// github.com carries that page's address. Each card says everything on its own.

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

  // The open item's one button. Every action but the setup runs on the server; the setup opens a
  // terminal, because the bot's login and token are typed there and never pass through the page.
  async function run(kind, button) {
    const opening = target;
    const say = (message) => { if (target === opening) { opening.note = message || null; render(); } };
    if (kind === "enable") return turnOn(button, say);
    if (kind === "update") return updateConfig(button, say);
    if (kind === "setup") {
      const result = await openSetup(button, setupRepository(opening));
      if (target !== opening) return;
      opening.note = result.note;
      if (!result.launched) opening.copyFallback = true;
      return render();
    }
    const repositoryId = opening.repositoryId;
    await busy(button, kind === "invite" ? "Inviting…" : "Protecting…", async () => {
      try {
        if (kind === "invite") {
          const result = await portalPostJson(`${repoUrl(repositoryId)}/invite`, {});
          if (result.repository) showRepo(repositoryId, result.repository);
          say(result.invited ? null : result.message);
        } else {
          const result = await applyProtection(repositoryId, "protect");
          await load(repositoryId, { fresh: true });
          say(result.refusal ? `Branch rules: ${result.refusal}.` : null);
        }
      } catch (error) {
        say(error.message);
      }
    });
  }

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
    const applies = target.kind === "account" || repoReport.applies;
    const view = target.kind === "account" ? describeAccount(accountReport) : repoView(accountReport, repoReport);
    const steps = applies ? cardSteps(accountReport, repoReport) : [];
    const complete = steps.length > 0 && steps.every((step) => step.done);
    // Finishing while the card is open: say so, drop the notes about what was in progress, and
    // close shortly. A card opened already complete just stays open.
    const justFinished = complete && target.hadOpenItems;
    if (!complete && steps.length > 0) target.hadOpenItems = true;
    if (complete) {
      target.note = null;
      target.copyFallback = false;
    }
    if (justFinished && !target.closeTimer) {
      const closing = target;
      closing.closeTimer = setTimeout(() => { if (target === closing && dialog.open) dialog.close(); }, COMPLETE_CLOSE_MS);
    }
    fill(dialog, {
      subject: target.kind === "account" ? "Bot account (all repos)" : target.name,
      state: view.label,
      message: justFinished
        ? `All set: ${summary(accountReport, view, steps)} This closes in ${COMPLETE_CLOSE_MS / 1000} seconds.`
        : applies ? summary(accountReport, view, steps) : view.message,
    });
    dialog.dataset.complete = String(complete);
    slot("state").dataset.level = view.level;

    // One thing to do at a time: only the first open item says what to do and carries a button.
    const current = steps.findIndex((step) => !step.done && !step.waiting);
    const step = steps[current] || null;
    const setupLaunch = target.kind === "repo" ? repoReport.setupLaunch : accountReport.setupLaunch;
    const launchable = Boolean(setupRepository(target)) && Boolean(setupLaunch?.supported);
    // Where the portal cannot open a terminal, or did not, the setup's button becomes its command.
    const showCommand = step?.button?.kind === "setup" && (!launchable || target.copyFallback);
    slot("steps").hidden = steps.length === 0;
    slot("steps").replaceChildren(...steps.map((entry, index) => stepItem(entry, index, {
      current: index === current,
      button: index === current && !showCommand ? entry.button : null,
      onRun: run,
    })));
    slot("bot-browser").hidden = !step?.url;
    slot("bot-browser").textContent = accountReport.guide?.lead || "";

    const ownerMessage = repoReport?.ownerMessage || null;
    slot("owner").hidden = !ownerMessage;
    slot("owner-message").textContent = ownerMessage || "";
    slot("owner-copy").copySource = ownerMessage || "";

    slot("command-row").hidden = !showCommand;
    if (showCommand && accountReport.guide) {
      fill(dialog, { command: accountReport.guide.command });
      slot("copy").copySource = accountReport.guide.command;
      if (target.kind === "repo") watching.add(target.repositoryId);
      watchingAccount = true;
    }
    const note = target.note || (showCommand && !launchable && setupLaunch?.reason ? setupLaunch.reason : null);
    slot("launch-note").hidden = !note;
    slot("launch-note").textContent = note || "";
    // Coming back to the window re-reads an open card, so a retry is only needed when GitHub did not
    // answer.
    slot("recheck").hidden = view.label !== "not checked";
  }

  return {
    showing: (key) => dialog.open && Boolean(target) && (key === "account" ? true : target.repositoryId === key),
    render,
    // Coming back to the window while the card is open with something left to do.
    refreshIfOpen() {
      if (!dialog.open || !target || dialog.dataset.complete === "true") return false;
      void refresh({ fresh: true });
      return true;
    },
    async open(next) {
      if (target?.closeTimer) clearTimeout(target.closeTimer);
      target = { ...next, copyFallback: false, note: null, hadOpenItems: false, closeTimer: null };
      fill(dialog, { subject: next.kind === "account" ? "Bot account (all repos)" : next.name, state: "checking", message: "Reading the bot's status from GitHub…" });
      slot("state").dataset.level = "muted";
      for (const name of ["steps", "bot-browser", "owner", "command-row", "launch-note", "recheck"]) slot(name).hidden = true;
      showError(null);
      if (!dialog.open) dialog.showModal();
      await refresh({ fresh: false });
    },
  };
}

// The repo whose folder the setup opens in: the card's own repo, or for the account card the first
// GitHub repo listed.
const setupRepository = (target) => (target.kind === "repo" ? target.repositoryId : firstGithubRepository());

// Every action button here waits on the server, some for seconds: while it does, the button is
// disabled and shows the portal's inline spinner beside a label saying what is happening.
async function busy(button, label, work) {
  const idle = [...button.childNodes];
  const spinner = document.createElement("span");
  spinner.className = "button-spinner";
  spinner.setAttribute("aria-hidden", "true");
  button.disabled = true;
  button.setAttribute("aria-busy", "true");
  button.replaceChildren(spinner, label);
  try {
    return await work();
  } finally {
    button.disabled = false;
    button.removeAttribute("aria-busy");
    // A re-render may already have relabeled the button; keep that label.
    if (button.firstChild === spinner) button.replaceChildren(...idle);
  }
}

// One sentence above the list: what works, and where to start when something does not.
function summary(accountReport, view, steps) {
  const first = steps.findIndex((step) => !step.done && !step.waiting);
  const bot = accountReport.botLogin || accountReport.savedLogin || "the bot";
  if (view.label === "not checked") return "GitHub did not answer. Check again in a moment.";
  // Every item checked but the account still reports something (a finding no item covers): say it
  // and its fix, rather than a green sentence under a red label.
  if (first === -1 && (view.level === "problem" || view.level === "warn") && accountReport.packageEnabled) {
    return [view.message, view.fix].filter(Boolean).join(" ");
  }
  if (first === -1) return accountReport.packageEnabled ? `Agents act on GitHub as ${bot}.` : `${bot} is ready; agents still act as you.`;
  return view.level === "warn" && accountReport.packageEnabled ? `Agents can work, but item ${first + 1} needs you soon.` : `Start at item ${first + 1}.`;
}

function stepItem(step, index, { current = false, button = null, onRun = null } = {}) {
  const action = current ? step.action : null;
  const url = current ? step.url : null;
  const item = fill(tpl("tpl-agent-identity-step"), { number: `${index + 1}.`, label: step.label, note: step.note || "", action: action || "" });
  item.dataset.done = String(step.done);
  item.dataset.waiting = String(Boolean(step.waiting));
  item.dataset.current = String(current);
  const mark = item.querySelector("[data-slot=mark]");
  mark.textContent = step.done ? "✓" : "";
  if (step.done) mark.setAttribute("aria-label", "Done");
  item.querySelector("[data-slot=action-row]").hidden = !action && !url && !button;
  item.querySelector("[data-slot=action]").hidden = !action;
  item.querySelector("[data-slot=url-row]").hidden = !url;
  if (url) {
    fill(item, { url });
    item.querySelector("[data-slot=copy]").copySource = url;
  }
  const run = item.querySelector("[data-slot=run]");
  run.hidden = !button;
  if (button) {
    run.textContent = button.label;
    run.addEventListener("click", () => void onRun(button.kind, run));
  }
  return item;
}

const dateText = (iso) => new Date(iso).toLocaleDateString();

const gitGap = (accountReport) => (accountReport.packageEnabled && (accountReport.findings || []).find((entry) => entry.id === "git-not-routed")) || null;

// The card's list, in setup order: the bot account, its token, agents using it, then (for one repo)
// the bot's invitation there and the branch rules. A repo item waits, unchecked and without an
// action, while the account is not usable.
export function cardSteps(accountReport, repoReport = null) {
  const findings = accountReport.findings || [];
  const has = (id) => findings.some((entry) => entry.id === id);
  const guide = new Map((accountReport.guide?.steps || []).map((step) => [step.id, step]));
  const login = accountReport.botLogin || accountReport.savedLogin;
  const tokenTrouble = findings.find((entry) => TOKEN_FINDINGS.has(entry.id));

  const accountDone = Boolean(accountReport.signedIn || accountReport.savedLogin) && !has("bot-is-user");
  const accountStep = { label: "Bot account", done: accountDone, note: has("bot-is-user") ? `${login} is your own account; use a separate one` : login || "not created yet" };
  const setup = { kind: "setup", label: "Open setup" };
  if (!login) Object.assign(accountStep, { action: `${guide.get("account")?.note || ""} Then Open setup asks for its login in a terminal.`.trim(), url: guide.get("account")?.url, button: setup });

  const tokenDone = Boolean(accountReport.botLogin) && !tokenTrouble;
  const tokenStep = { label: "Token", done: tokenDone };
  if (tokenDone) {
    tokenStep.note = [accountReport.scopes ? accountReport.scopes.join(", ") : "fine-grained", accountReport.expiresAt ? `expires ${dateText(accountReport.expiresAt)}` : "no expiry date"].join(" · ");
  } else {
    tokenStep.note = !login ? "not created yet" : tokenTrouble ? tokenTrouble.message : "GitHub did not accept it";
    const renewing = accountDone && (Boolean(tokenTrouble) || !accountReport.botLogin);
    // A token in the keychain only needs the setup to move it; wrong scopes need a new token, not a
    // regenerated one.
    const wrongKind = ["broad-scopes", "fine-grained-token", "scopes-missing"].includes(tokenTrouble?.id);
    const page = guide.get(renewing && !wrongKind ? "renew" : "token");
    if (tokenTrouble?.id === "token-in-keychain") Object.assign(tokenStep, { action: "Open setup moves it where agents can read it.", button: setup });
    else if (page) Object.assign(tokenStep, { action: `${page.note} Then Open setup and paste it in the terminal.`, url: page.url, button: setup });
    else Object.assign(tokenStep, { action: "Open setup and paste a new token in the terminal.", button: setup });
  }

  // On, but agents' Git does not include the bot's settings: gh uses the bot, pushes do not.
  const gap = gitGap(accountReport);
  const useStep = {
    label: "Agents use the bot",
    done: Boolean(accountReport.packageEnabled) && !gap,
    note: gap ? gap.message : accountReport.packageEnabled ? "on" : "off; agents act as you",
    ...(gap ? { action: "Update now, then start new agent sessions.", button: { kind: "update", label: "Update now" } }
      : accountReport.enableOffered ? { button: { kind: "enable", label: "Turn on" } }
        : accountReport.packageEnabled ? {} : { action: "The setup turns this on when it finishes.", button: setup }),
  };
  const steps = [accountStep, tokenStep, useStep];
  if (!repoReport) return steps;

  if (repoReport.account === "waiting") {
    return [...steps,
      { label: "Invited to this repo", done: false, waiting: true, note: "checked once the bot account works" },
      { label: "Branch rules", done: false, waiting: true, note: "checked once the bot account works" }];
  }
  const repoHas = (id) => repoReport.findings.some((entry) => entry.id === id);
  const finding = (id) => repoReport.findings.find((entry) => entry.id === id);
  const known = repoReport.state !== "unavailable" || repoReport.findings.length > 0;
  const askOwner = "Ask the owner; the message below says what to do.";

  const inviteId = ["invite-pending", "not-collaborator", "bot-is-admin"].find(repoHas);
  const invite = { label: "Invited to this repo", done: known && !inviteId };
  if (!known) invite.note = "not checked";
  else if (!inviteId) invite.note = "write access";
  else {
    invite.note = { "invite-pending": "invited; not accepted yet", "not-collaborator": "not invited", "bot-is-admin": "the bot is an admin; lower it to Write" }[inviteId];
    if (finding(inviteId).owner) invite.action = askOwner;
    else if (inviteId === "bot-is-admin") invite.action = "On github.com, in the repo's Settings under Collaborators, change the bot's role to Write.";
    else if (inviteId === "invite-pending") Object.assign(invite, { action: "Accepts the invitation as the bot.", button: { kind: "invite", label: "Accept invitation" } });
    else Object.assign(invite, { action: "Invites the bot as you, then accepts as the bot.", button: { kind: "invite", label: "Invite the bot" } });
  }

  const rulesId = ["protection", "protection-unverified", "protection-unchecked"].find(repoHas);
  const rules = { label: "Branch rules", done: known && !rulesId };
  if (!known) rules.note = "not checked";
  else if (!rulesId) rules.note = "approval required to merge";
  else {
    rules.note = { protection: "missing", "protection-unverified": "applied, but you can't see who may bypass them", "protection-unchecked": "could not be read" }[rulesId];
    if (finding(rulesId).owner) rules.action = askOwner;
    else if (rulesId === "protection") Object.assign(rules, { action: "Adds rules on GitHub so nothing merges without an approval.", button: { kind: "protect", label: "Protect branches" } });
  }
  return [...steps, invite, rules];
}

// ---------------------------------------------------------------------------------------------

// Coming back to the window after the setup: re-read the account and only the repos being set up.
// An open card with something left to do is re-read too: whatever was done on github.com or in a
// terminal shows when the user comes back, with no Check again.
function refreshOnReturn() {
  if (document.visibilityState !== "visible") return;
  if (Date.now() - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
  lastFocusRefresh = Date.now();
  const cardRead = card?.refreshIfOpen() || false;
  if (!watchingAccount && watching.size === 0) return;
  if (watchingAccount && !cardRead) loadAccount({ fresh: true }).catch(() => {});
  for (const repositoryId of watching) load(repositoryId, { fresh: true }).catch(() => {});
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
