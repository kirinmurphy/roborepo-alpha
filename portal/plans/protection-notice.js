// The Plans page's one-time branch protection notice: one line per repo whose plans or default
// branch is not protected on GitHub. Each viewer sees a line once; it returns only when something
// they can act on changes. The full status stays available from the repo's menu on Home.
import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { applyProtection, loadProtection } from "/portal/shared/protection-panel.js";

const SEEN_KEY = "roborepo.protection-notices";
// Storage can be unavailable (private windows, blocked site data); then a line is remembered for
// this page load only.
const seenInMemory = new Map();

// `container` holds the lines; `panel` is the protection panel controller.
export function createProtectionNotices({ container, panel }) {
  // The lines on screen, by repository id. A line stays up for the rest of this page load.
  const shown = new Map();
  let sequence = 0;

  // Reads each repo's status, one at a time so a long repo list never starts dozens of GitHub
  // calls at once. `repositoryIds` are the page's scanned GitHub repos.
  async function refresh(repositoryIds) {
    const current = ++sequence;
    shown.clear();
    render();
    for (const repositoryId of repositoryIds) {
      let report;
      try {
        report = await loadProtection(repositoryId);
      } catch {
        continue;
      }
      if (current !== sequence) return;
      if (shouldNotify(recall(repositoryId), report)) shown.set(repositoryId, report);
      remember(repositoryId, report);
      render();
    }
  }

  // A panel or notice action changed this repo: drop its line unless it still needs attention.
  function update(repositoryId, report) {
    if (shown.has(repositoryId) && isNoticeable(report)) shown.set(repositoryId, report);
    else shown.delete(repositoryId);
    remember(repositoryId, report);
    render();
  }

  function render() {
    container.hidden = shown.size === 0;
    container.replaceChildren(...[...shown].map(([repositoryId, report]) => noticeLine(repositoryId, report)));
  }

  function noticeLine(repositoryId, report) {
    const repository = { repositoryId, displayName: report.repository };
    const node = fill(tpl("tpl-protection-notice"), { text: noticeText(report) });
    const protect = node.querySelector("[data-slot=protect]");
    protect.hidden = !(report.admin && ["missing", "drifted"].includes(report.state));
    protect.addEventListener("click", async () => {
      protect.disabled = true;
      protect.textContent = "Protecting…";
      try {
        const result = await applyProtection(repositoryId, "protect");
        update(repositoryId, result);
        panel.open(repository, { report: result });
      } catch {
        // The panel reads the state itself and shows why the action failed to apply.
        panel.open(repository);
      }
    });
    node.querySelector("[data-slot=details]").addEventListener("click", () => panel.open(repository, { report }));
    return node;
  }

  return { refresh, update };
}

const isNoticeable = (report) => ["missing", "conflicting"].includes(report.state) || (report.state === "drifted" && report.admin);

// Whether a line appears, given what this viewer last saw for the repo: the first time a repo
// needs attention, when its state changes into one that does, and when the viewer becomes an admin
// and can now fix it.
function shouldNotify(previous, report) {
  if (!isNoticeable(report)) return false;
  if (!previous) return true;
  return previous.state !== report.state || (!previous.admin && report.admin);
}

function noticeText(report) {
  const account = report.admin ? "" : ` Signed in to GitHub as ${report.login}, who is not an admin of this repo; a repo admin must run roborepo protect.`;
  if (report.state === "conflicting") return `${report.repository}: ${report.conflicts.map((conflict) => conflict.detail).join(" ")}`;
  if (report.state === "missing") {
    const risks = report.policies.filter((policy) => policy.missingRules.length > 0).map((policy) => policy.risk);
    return `${report.repository} is not fully protected on GitHub: ${risks.join("; ")}.${account}`;
  }
  const drifted = report.policies.filter((policy) => policy.status === "drifted").map((policy) => `${policy.name} ${policy.detail}`);
  return `${report.repository}: branch protection is out of date on GitHub (${drifted.join("; ")}).`;
}

function recall(repositoryId) {
  return seenInMemory.get(repositoryId) || readSeen()[repositoryId] || null;
}

// A read that could not reach GitHub says nothing about the repo, so it never replaces the last
// state seen; a network blip would otherwise bring the same line back.
function remember(repositoryId, report) {
  if (report.state === "unavailable") return;
  const entry = { state: report.state, admin: report.admin };
  seenInMemory.set(repositoryId, entry);
  try {
    localStorage.setItem(SEEN_KEY, JSON.stringify({ ...readSeen(), [repositoryId]: entry }));
  } catch {}
}

function readSeen() {
  try {
    const value = JSON.parse(localStorage.getItem(SEEN_KEY) || "{}");
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    return {};
  }
}
