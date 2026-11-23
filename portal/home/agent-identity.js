// The GitHub bot identity on Home: a one-line status at the foot of each GitHub repo card, and the
// card behind it (from the line's Details button or the repo menu) with the one next step. The page
// only reads status and asks the server to open `roborepo github setup` in a terminal; the token is
// typed at that terminal's hidden prompt and never passes through here.
import { portalFillSlots as fill, portalGetJson, portalPostJson, portalTpl as tpl, portalWireBackdropClose } from "/portal/shared/api.js";
import { supportsProtectionPanel } from "/portal/shared/protection-panel.js";

const identityUrl = (repositoryId) => `/api/repositories/${encodeURIComponent(repositoryId)}/agent-identity`;
// Matches the server's cache, so re-rendering Home does not ask again sooner than it would answer.
const REUSE_MS = 5 * 60_000;
const FOCUS_THROTTLE_MS = 2_000;
const SETUP_COMMAND_PATTERN = /roborepo github setup/;

// The bot identity is a GitHub feature: only listed GitHub repos show it. The server has the last
// word (`applies: false`), so a repo it turns down shows nothing either.
export function supportsAgentIdentity(repository) {
  return supportsProtectionPanel(repository) && String(repository.repositoryId).startsWith("git:github.com/");
}

const reports = new Map(); // repositoryId -> { at, report }
const pending = new Map(); // repositoryId -> Promise
const lines = new Map(); // repositoryId -> Set of mounted line elements
// Repos whose setup was opened or whose command was shown: the user is away doing it, so coming
// back to the window re-reads these, and only these, past the cache.
const watching = new Set();
let lastFocusRefresh = 0;
let card = null;

function load(repositoryId, { fresh = false } = {}) {
  const known = reports.get(repositoryId);
  if (!fresh && known && Date.now() - known.at < REUSE_MS) return Promise.resolve(known.report);
  if (!fresh && pending.has(repositoryId)) return pending.get(repositoryId);
  const request = portalGetJson(`${identityUrl(repositoryId)}${fresh ? "?fresh=1" : ""}`)
    .then((report) => {
      reports.set(repositoryId, { at: Date.now(), report });
      if (!report.applies || !describeAgentIdentity(report).offersSetup) watching.delete(repositoryId);
      for (const line of lines.get(repositoryId) || []) renderLine(line, report);
      if (card?.isShowing(repositoryId)) card.render(report);
      return report;
    })
    .finally(() => { if (pending.get(repositoryId) === request) pending.delete(repositoryId); });
  pending.set(repositoryId, request);
  return request;
}

// Mounts the status line into a repo card's slot. Home rebuilds its cards on every refresh, so a
// known result renders at once and the read happens only when it is missing or old.
export function mountAgentIdentityLine(slot, repository) {
  if (!slot || !supportsAgentIdentity(repository)) return;
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

export function openAgentIdentityCard(repository) {
  card ??= buildCard();
  void card.open(repository);
}

// What the card and the line say for a report: a short state label, how worried to look, the
// finding to show (the first problem, else the first note or unchecked one), and whether the next
// step is the terminal setup.
export function describeAgentIdentity(report) {
  const findings = report.findings || [];
  const shown = findings.find((entry) => entry.severity === "problem")
    || findings.find((entry) => entry.severity === "warn" || entry.severity === "unchecked")
    || null;
  const renew = findings.some((entry) => entry.id === "expiring" || entry.id === "expired");
  let label;
  let level;
  let message;
  switch (report.state) {
    case "not-set-up":
      label = "not set up";
      level = "warn";
      message = "Agents act on GitHub as you. Set up a separate bot account so GitHub itself refuses agent pushes to main and unreviewed merges.";
      break;
    case "healthy":
      label = renew ? "renew soon" : "healthy";
      level = shown ? "warn" : "ok";
      message = shown ? shown.message : `Agents act as ${report.botLogin}.`;
      break;
    case "problem":
      label = renew ? "token expired" : "needs attention";
      level = "problem";
      message = shown.message;
      break;
    default:
      label = "not checked";
      level = "muted";
      message = shown ? shown.message : `The status could not be checked: ${report.reason}.`;
  }
  const fix = shown?.fix || null;
  const offersSetup = report.state === "not-set-up" || SETUP_COMMAND_PATTERN.test(fix || "");
  return { label, level, message, fix, offersSetup };
}

function renderLine(line, report) {
  if (!report.applies) {
    line.hidden = true;
    return;
  }
  const view = describeAgentIdentity(report);
  line.hidden = false;
  fill(line, { state: view.label, text: report.state === "healthy" && view.level === "ok" ? "" : view.message });
  line.querySelector("[data-slot=state]").dataset.level = view.level;
}

function buildCard() {
  const dialog = document.getElementById("agent-identity-dialog");
  const slot = (name) => dialog.querySelector(`[data-slot="${name}"]`);
  let target = null;
  let launchNote = null;

  slot("close").addEventListener("click", () => dialog.close());
  portalWireBackdropClose(dialog, () => dialog.close());
  slot("recheck").addEventListener("click", () => refreshTarget({ fresh: true }));
  slot("open-setup").addEventListener("click", () => openSetup());

  function showError(message) {
    slot("error").hidden = !message;
    slot("error").textContent = message || "";
  }

  async function refreshTarget({ fresh }) {
    const opening = target;
    showError(null);
    try {
      const report = await load(opening.repositoryId, { fresh });
      if (target === opening) render(report);
    } catch (error) {
      if (target === opening) showError(error.message);
    }
  }

  async function openSetup() {
    const opening = target;
    const button = slot("open-setup");
    button.disabled = true;
    showError(null);
    watching.add(opening.repositoryId);
    try {
      const result = await portalPostJson(`${identityUrl(opening.repositoryId)}/setup`, {});
      if (target !== opening) return;
      launchNote = result.launched
        ? "A terminal opened running roborepo github setup in this repo's folder. Finish it there; this card updates when you come back."
        : launchFailureNote(result);
      if (!result.launched) opening.copyFallback = true;
      render(reports.get(opening.repositoryId)?.report);
    } catch (error) {
      if (target === opening) {
        opening.copyFallback = true;
        showError(error.message);
        render(reports.get(opening.repositoryId)?.report);
      }
    } finally {
      button.disabled = false;
    }
  }

  function render(report) {
    if (!report || !target) return;
    const view = report.applies ? describeAgentIdentity(report) : { label: "not on GitHub", level: "muted", message: "This repo's remote is not on github.com, so there is no bot account to set up.", fix: null, offersSetup: false };
    fill(dialog, { state: view.label, message: view.message });
    slot("state").dataset.level = view.level;
    slot("fix").hidden = !view.fix;
    slot("fix").textContent = view.fix ? `Fix: ${view.fix}` : "";
    const expires = report.expiresAt ? new Date(report.expiresAt) : null;
    slot("expiry").hidden = !expires;
    slot("expiry").textContent = expires ? `The bot's token expires ${expires.toLocaleDateString()}.` : "";

    const guide = report.guide;
    slot("guide").hidden = !view.offersSetup || !guide;
    if (guide) {
      slot("links").replaceChildren(...guide.links.map((link) => {
        const item = fill(tpl("tpl-agent-identity-link"), { link: link.label, note: link.note });
        item.querySelector("a").href = link.url;
        return item;
      }));
      fill(dialog, { "guide-expiry": `Token expiry: ${guide.expiry}`, "token-warning": guide.tokenWarning, command: guide.command });
      slot("copy").copySource = guide.command;
    }
    const launchable = view.offersSetup && report.setupLaunch?.supported;
    slot("open-setup").hidden = !launchable;
    // Where the button cannot work (another OS, no checkout) or did not, the command is the step.
    const showCommand = view.offersSetup && (!launchable || target.copyFallback);
    slot("command-row").hidden = !showCommand;
    if (showCommand) watching.add(target.repositoryId);
    const note = launchNote || (view.offersSetup && !launchable && report.setupLaunch?.reason ? report.setupLaunch.reason : null);
    slot("launch-note").hidden = !note;
    slot("launch-note").textContent = note || "";
  }

  return {
    isShowing: (repositoryId) => dialog.open && target?.repositoryId === repositoryId,
    render: (report) => render(report),
    async open(repository) {
      target = { repositoryId: repository.repositoryId, copyFallback: false };
      launchNote = null;
      fill(dialog, { repository: repository.displayName || repository.repositoryId, state: "checking", message: "Reading the bot account's status from GitHub…" });
      slot("state").dataset.level = "muted";
      for (const name of ["fix", "expiry", "command-row", "launch-note", "guide", "open-setup"]) slot(name).hidden = true;
      showError(null);
      if (!dialog.open) dialog.showModal();
      await refreshTarget({ fresh: false });
    },
  };
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

// Coming back to the window after the setup: re-read only the repos the user was setting up.
function refreshOnReturn() {
  if (document.visibilityState !== "visible" || watching.size === 0) return;
  if (Date.now() - lastFocusRefresh < FOCUS_THROTTLE_MS) return;
  lastFocusRefresh = Date.now();
  for (const repositoryId of watching) load(repositoryId, { fresh: true }).catch(() => {});
}
document.addEventListener("visibilitychange", refreshOnReturn);
window.addEventListener("focus", refreshOnReturn);
