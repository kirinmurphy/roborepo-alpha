// Tokens page. Fetches the /api/data report and renders it in a layered, layperson-readable
// layout: verdict → findings → chart → investigation sections → distilled report → full data.
// All prose is deterministic:
// finding headlines/details come from report.insights (deriveInsights templates), evidence
// paragraphs interpolate report fields, and section framing is static UI copy.

import { portalGetJson, portalPostJson, portalHideLoading, portalHideLoadingNow, portalSetUpdatedAt, portalWireBackdropClose } from "/portal/shared/api.js";
import { pageState } from "./page-state.js";
import { activePresentedHarnesses, formatHarnessList } from "/portal/shared/harness-cohort.js";
import { checkForHarnesses, harnessWarningElement } from "/portal/shared/harness-warning.js";
import { fetchSetupState } from "/portal/shared/setup-api.js";
import { createConditionsReport } from "./conditions-report.js";
import { sessionConditionLine, capturedSessionFindings } from "./conditions-context.js";
import { createDocGuideModal } from "/portal/shared/doc-guide-modal.js";

// ── State ──
let firstLoad = true;
let lastVersion = null;
let hasData = false;
let setupReady = false;
let pollTimer = null;
const TOKENS_POLL_MS = 5000;
// Last applied setup snapshot + the cascade rung it produced — load() re-applies the setup state
// when a real-data response flips hasData (first captures land mid-poll, or a wipe empties the
// spool), so the no-data panel and the full report follow without a config change or reload.
let lastSetup = null;
let lastSetupState = null;
// The most recent report object — session chips and timeline marks look sessions up here at
// click time, so a click always acts on the live report rather than a stale closure.
let lastSessionData = null;

// ── Formatting helpers (local) ──
const fmt = (n) => Number(n || 0).toLocaleString("en-US");
const tokShort = (n) => {
  n = Number(n || 0);
  if (n >= 1e9) return (n / 1e9).toFixed(1) + "B";
  if (n >= 1e6) return (n / 1e6).toFixed(n >= 1e7 ? 0 : 1) + "M";
  if (n >= 1e3) return Math.round(n / 1e3) + "k";
  return String(Math.round(n));
};
const pct = (n) => Math.round(n * 100);
const esc = (s) => String(s == null ? "" : s).replace(
  /[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

const conditionsView = createConditionsReport({
  openSession: openSessionModal,
  getData: () => lastSessionData,
  onSaved: async () => { lastVersion = null; await load(); },
});

// ── Init ──
init();

async function init() {
  // Setup-state poll: reads /api/config (same as the existing telemetry page's
  // refreshTelemetryState) to determine which cascade rung we're on. Reuses pageState()
  // from ./page-state.js. The config API returns a flat `telemetry` object
  // (cfg.telemetry.enabled), not nested under packages.
  //
  // Mock data: when the page is NOT in the "full" state (no harness installed, or no
  // real telemetry data), we still fetch /api/data and render the report below the
  // banner — the demo spool (demo.jsonl) feeds the same analyzeTelemetry pipeline.
  // A mock-data disclaimer banner appears at the top of the report when this is the
  // case. Once a real harness is installed and captures real telemetry, the banner
  // disappears and the report shows real data through the same pipeline.
  let cfg;
  let setup;
  try {
    [cfg, setup] = await Promise.all([portalGetJson("/api/config"), fetchSetupState()]);
  } catch {
    if (firstLoad) { firstLoad = false; portalHideLoadingNow(); }
    return;
  }
  const telemetryOn = setup.telemetry.enabled;
  const harnessCount = setup.harnesses.active.length;
  // Package capability lookups (docLookupHint) read this snapshot — installed/available state
  // comes from the same /api/config the setup cascade already uses. No second fetch.
  window.__tokensConfig = cfg;
  await applySetupState({ telemetryOn, activeHarnessCount: harnessCount, snap: setup });

  // Always attempt to load the report — even when the setup state is not "full".
  // In the mock state (no real harness), we fetch from /api/tokens/mock which
  // reads the bundled mock-spool.jsonl through the same analyzeTelemetry pipeline.
  // In the full state, we fetch from /api/data (the real spool).
  const isFullState = setupReady;
  await load(!isFullState);
  // Re-apply the setup cascade after the first report load: hasData is now established from the
  // real /api/data response, so pageState reflects actual captures — the "no telemetry data yet"
  // panel hides when real data exists instead of persisting from the pre-load default.
  await applySetupState({ telemetryOn, activeHarnessCount: harnessCount, snap: setup });
  if (setupReady) {
    clearInterval(pollTimer);
    pollTimer = setInterval(() => load(), TOKENS_POLL_MS);
  }
}

// ── Four-state cascade (mirrors the existing telemetry page) ──
// The /api/data endpoint reads the spool directly; the cascade gates whether the page shows
// the setup banner vs the report. When telemetry is off in the hermetic test env, /api/data
// still returns demo data — so we check capture_count as the real gate, falling back to
// data if the spool has content even when the config says telemetry is off.
async function applySetupState({ telemetryOn, activeHarnessCount, snap }) {
  setupReady = telemetryOn && activeHarnessCount > 0;
  lastSetup = { telemetryOn, activeHarnessCount, snap };
  if (!setupReady && firstLoad) { firstLoad = false; portalHideLoadingNow(); }

  const offPanel = document.getElementById("tokensoff");
  const bannerHost = document.getElementById("tokensbanner");
  const content = document.getElementById("tokenscontent");
  const state = pageState({ telemetryOn, activeHarnessCount, hasData });
  lastSetupState = state;

  // The banner (telemetry-off or harness-warning) shows in every non-full state.
  // The content (report) is ALWAYS shown — in non-full states it renders the demo
  // spool's data below the banner, with a mock-data disclaimer. This lets the page
  // demonstrate the full report even before a real harness is installed.
  // The "install a supported harness" banner is the SHARED component
  // (portal/shared/harness-warning.js — the same portal-notice the Agents page renders);
  // it shows below the state panel whenever the machine has no active harness. When telemetry is
  // also off, the telemetry prompt remains visible above it so both setup steps are available.
  const sharedBanner = harnessWarningElement(snap, { onCheck: async () => { await checkForHarnesses(); await init(); } });
  if (state === "telemetry-off") {
    offPanel.style.display = "";
    const title = offPanel.querySelector("[data-slot=title]");
    const body = offPanel.querySelector("[data-slot=body]");
    if (activeHarnessCount === 0) {
      title.textContent = "Token Activity Tracking";
      body.textContent = "Turn telemetry on before token usage can be captured.";
    } else {
      title.textContent = "Token Activity Tracking";
      body.textContent = "Token usage is not being captured. Turn telemetry on to start collecting data across your harnesses.";
    }
  } else if (state === "no-harness") {
    offPanel.style.display = telemetryOn ? "none" : "";
    if (!telemetryOn) {
      offPanel.querySelector("[data-slot=title]").textContent = "Token Activity Tracking";
      offPanel.querySelector("[data-slot=body]").textContent = "Enable token tracking to capture and visualize token usage across harnesses.";
    }
  } else if (state === "no-data") {
    offPanel.style.display = "";
    const title = offPanel.querySelector("[data-slot=title]");
    const body = offPanel.querySelector("[data-slot=body]");
    title.textContent = "No telemetry data yet";
    body.textContent = "Telemetry is on and a harness is active, but nothing has been captured yet. Run a session in your harness — this page fills in as usage data lands.";
  } else {
    offPanel.style.display = "none";
  }

  // Banner host: the shared harness-warning notice in every state where it applies.
  bannerHost.style.display = sharedBanner ? "" : "none";
  bannerHost.replaceChildren(...(sharedBanner ? [sharedBanner] : []));

  // Content is always visible — the report renders below the banner.
  content.hidden = false;

  // Wire the enable-telemetry button (same pattern as the existing page).
  const enableBtn = document.getElementById("tokensenable");
  if (enableBtn) {
    enableBtn.hidden = telemetryOn;
    enableBtn.onclick = async () => {
      enableBtn.disabled = true;
      const errEl = document.getElementById("tokensenableerr");
      if (errEl) errEl.textContent = "";
      try {
        await portalPostJson("/api/config/packages", { id: "telemetry", enabled: true });
        await init();
      } catch (err) {
        if (errEl) errEl.textContent = "failed to enable: " + ((err && err.message) || err);
        enableBtn.disabled = false;
      }
    };
  }
}

// ── Load: fetch the report and render every layer ──
// force=true renders even when setupReady is false (the mock-data path): fetches
// from /api/tokens/mock instead of /api/data, and shows the mock-data disclaimer.
async function load(force) {
  if (!setupReady && !force) {
    if (firstLoad) { firstLoad = false; portalHideLoading(); }
    return;
  }
  const endpoint = force ? "/api/tokens/mock" : "/api/data";
  let data;
  try {
    data = await portalGetJson(endpoint);
  } catch {
    if (firstLoad) { firstLoad = false; portalHideLoadingNow(); }
    return;
  }
  if (firstLoad) { firstLoad = false; portalHideLoading(); }
  if (document.querySelector("dialog[open]")) return;
  if (!force && data.version === lastVersion) return;
  lastVersion = data.version;
  lastSessionData = data;
  // hasData reflects REAL captures only — the mock endpoint's spool always has records, and
  // letting it set hasData would advance the cascade to the real-data rung (hiding the no-data
  // panel and the mock disclaimer) before any real telemetry exists.
  if (!force) {
    hasData = (data.capture_count ?? 0) > 0;
    // Re-apply the setup cascade when the report's hasData flips the shown rung (e.g. the first
    // real captures land and the "no telemetry data yet" panel should give way to the report).
    if (lastSetup) {
      const state = pageState({ telemetryOn: lastSetup.telemetryOn, activeHarnessCount: lastSetup.activeHarnessCount, hasData });
      if (state !== lastSetupState) {
        lastSetupState = state;
        applySetupState(lastSetup);
      }
    }
  }
  portalSetUpdatedAt(new Date(), { cadenceMs: pollTimer ? TOKENS_POLL_MS : null });

  // Mock-data disclaimer: shown when the page is NOT in the "full" state (no real
  // harness installed or no real telemetry data). The report renders below the
  // banner using mock spool data through the same pipeline.
  const showMockDisclaimer = !setupReady;
  const mockBanner = document.getElementById("mock-disclaimer");
  if (mockBanner) mockBanner.style.display = showMockDisclaimer ? "" : "none";

  renderVerdict(data);
  renderMeta(data);
  renderFindings(data.insights || []);
  renderAgentPrompt(data);
  renderInvestigationSections(data);
  renderTimelineStrip(data);
  conditionsView.render(data, setupReady);
  renderFullData(data);
}

// ── Frame-of-reference meta line ──
// Period first and large (the headline: "what window is this?"), then the counts it is drawn from
// as a dim detail line, with the Codex provider rate limit (when reported) as a trailing clause.
// Sessions are distinct agent sessions; "with token data" are those whose usage was captured;
// events are the individual records inside them (data.event_count — see the tooltip).
function renderMeta(data) {
  const el = document.getElementById("tokensmeta");
  if (!el) return;
  const sessions = data.sessions || [];
  const total = data.conditions.data_quality.sessions;
  const parts = [
    fmt(total) + " sessions" + (sessions.length < total ? ` (${fmt(sessions.length)} with token data)` : ""),
    fmt(data.event_count ?? data.capture_count ?? 0) + " events recorded",
  ];
  if (data.codex_provider_rate_limits) {
    parts.push("Codex limit " + codexRateLimitLabel(data.codex_provider_rate_limits));
  }
  // Period: first session start → last session end (no precomputed field; derived here).
  const firstTs = sessions.length ? sessions.reduce((m, s) => (s.first_ts < m ? s.first_ts : m), sessions[0].first_ts) : null;
  const lastTs = sessions.length ? sessions.reduce((m, s) => (s.last_ts > m ? s.last_ts : m), sessions[0].last_ts) : null;
  const day = (ts) => new Date(ts).toLocaleDateString("en-US", { month: "short", day: "numeric" });
  el.replaceChildren();
  if (firstTs && lastTs) {
    const period = document.createElement("div");
    period.className = "t2-meta-period";
    period.textContent = day(firstTs) + " – " + day(lastTs);
    el.appendChild(period);
  }
  const detail = document.createElement("div");
  detail.className = "t2-meta-detail";
  detail.textContent = parts.join(" · ");
  detail.dataset.tip = "Sessions: distinct agent sessions seen.\nWith token data: sessions whose token usage was captured.\nEvents: the individual activity records (such as tool calls) logged inside those sessions.";
  el.appendChild(detail);
}

function codexRateLimitLabel(rateLimits) {
  const rows = Array.isArray(rateLimits) ? rateLimits : [rateLimits];
  const row = rows.find((limit) => typeof limit?.used_percent === "number") || rows[0];
  if (!row) return "reported";
  const used = typeof row.used_percent === "number" ? row.used_percent + "% used" : "reported";
  return (row.name ? row.name + " · " : "") + used;
}

// ── Layer 1: Waste-stat dashboard (own section above Action items) ──
function renderVerdict(data) {
  const grid = document.getElementById("waste-grid");

  // Top-level waste metric: % of usage that is identifiable waste, color-graded against each
  // card's danger line. One card per range — "this week" (trailing 7 days) and "all time" (the
  // full report period). data.waste is built server-side per turn with each turn counted once
  // (scripts/cli/telemetry-waste.mjs), so a card's sources add up exactly to its total.
  const wasteParts = (range) => WASTE_SOURCES
    .map((source) => ({
      label: source.label,
      tokens: data.waste?.[range]?.categories?.[source.key] ?? 0,
      note: source.note,
    }))
    .filter((part) => part.tokens > 0);

  grid.replaceChildren();
  const allParts = wasteParts("all");
  if (!allParts.length) {
    const empty = document.createElement("div");
    empty.className = "waste-card";
    empty.innerHTML = `<span class="dl-text">No identifiable waste in this window.</span>`;
    grid.appendChild(empty);
    return;
  }

  const allTotal = (data.timeline || []).reduce((s, p) => s + (p.delta || 0), 0);
  const weekTotal = data.usage_windows?.seven_day;
  if (weekTotal) grid.appendChild(wasteCard("This week", weekTotal, wasteParts("week"), 16));
  grid.appendChild(wasteCard("All time", allTotal, allParts, 10));
}

// Waste sources in display order. `key` matches data.waste categories; `label` is the card text and
// the lookup for its Investigate section.
const WASTE_SOURCES = [
  { key: "testing", label: "over-testing", note: "full-suite reruns with no edit since the last run" },
  { key: "loops", label: "runaway loops", note: "" },
  { key: "reads", label: "redundant reads", note: "" },
  { key: "spikes", label: "spike excess", note: "turn size above the spike threshold" },
];

// Sticky-header offset for scroll targets, measured ONCE at load (per user: no scroll/resize
// re-measure) plus a 1rem breathing gap.
let stickyHeaderOffset = 0;
function measureStickyHeader() {
  const header = document.querySelector(".portal-header");
  stickyHeaderOffset = header ? header.getBoundingClientRect().height + 16 : 16;
  // Section heads stick just under the portal header.
  document.documentElement.style.setProperty("--portal-header-h", (header ? header.getBoundingClientRect().height : 0) + "px");
}

// "Show/Hide suggested fixes": item hints are hidden by default (too dense); the toggle lives in
// the Investigate header. State is a class on the container, so it survives per-poll re-renders.
function wireHintToggle() {
  const toggle = document.getElementById("hint-toggle");
  const host = document.getElementById("invest-sections");
  toggle.addEventListener("click", () => {
    const show = host.classList.toggle("show-hints");
    toggle.setAttribute("aria-pressed", show ? "true" : "false");
    toggle.textContent = show ? "Hide suggested fixes" : "Show suggested fixes";
  });
}

// Scroll to and auto-expand an Investigate section. Collapsing (or a click on an already-open
// section's summary) must NOT scroll — only the "jump to evidence" path does.
function scrollToSection(section) {
  section.open = true;
  const y = section.getBoundingClientRect().top + window.scrollY - stickyHeaderOffset;
  window.scrollTo({ top: y, behavior: "smooth" });
}

// Click/keyboard delegation for waste-source links → jump to the matching Investigate section.
// One listener, wired once — sections re-render per poll, so the handler looks the section up at
// click time instead of closing over elements.
function wireWasteSourceLinks() {
  const jump = (el) => {
    const section = document.querySelector(`#invest-sections details[data-sec-key="${el.dataset.secKey}"]`);
    if (section) scrollToSection(section);
  };
  document.addEventListener("click", (e) => {
    const el = e.target.closest?.(".waste-source-link");
    if (!el) return;
    e.preventDefault();
    jump(el);
  });
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Enter" && e.key !== " ") return;
    const el = e.target.closest?.(".waste-source-link");
    if (!el) return;
    e.preventDefault();
    jump(el);
  });
  // The "+N more" control behaves like a dropdown styled as a tooltip: click toggles a persistent
  // popover; clicking an item or outside dismisses it. (Plain data-tip-html would hover-dismiss,
  // which is wrong for a click-open menu.) One instance open at a time.
  document.addEventListener("click", (e) => {
    const moreBtn = e.target.closest?.(".waste-more");
    const item = e.target.closest?.(".waste-source-link");
    document.querySelectorAll(".waste-more.open").forEach((btn) => {
      if (btn !== moreBtn) { btn.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }
    });
    if (moreBtn) {
      e.preventDefault();
      const open = moreBtn.classList.toggle("open");
      moreBtn.setAttribute("aria-expanded", open ? "true" : "false");
      return;
    }
    if (item) {
      // Item click: jump (handled above) AND close whichever dropdown is open.
      document.querySelectorAll(".waste-more.open").forEach((btn) => {
        btn.classList.remove("open");
        btn.setAttribute("aria-expanded", "false");
      });
    }
  });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") { document.querySelectorAll(".waste-more.open").forEach((btn) => { btn.classList.remove("open"); btn.setAttribute("aria-expanded", "false"); }); } });
  measureStickyHeader();
}

// ── Session drill-down: the popup behind every session chip and Investigate row ──
// Four things, all deterministic (server's deriveSessionFindings supplies the prose):
//   1. WHAT this session was — title, repo/branch, harness, when.
//   2. WHAT happened — the findings rows ("Grep fired 22× in a row…").
//   3. WHAT to do — each finding's hint.
//   4. COPY PROMPT FOR AGENT — <portal-copy-button> with the server-built analysis prompt.
// Jargon (session ids, transcript paths, model history) lives in the agent prompt, not here.
// Transcript lookup is best-effort: heaviest turns render when the transcript is on disk; a
// rotated-away transcript just means "no turns", the prompt still works.
const sessionModal = document.getElementById("tokenssession-modal");
const sessionModalBody = sessionModal.querySelector('[data-slot="body"]');
// Close paths: the shared X button (its custom element renders the icon but does NOT self-wire
// click behavior — the host page must listen, same as the v1/doc dialogs) and backdrop clicks.
sessionModal.querySelector('[data-slot="close"]').addEventListener("click", () => sessionModal.close());
portalWireBackdropClose(sessionModal, () => sessionModal.close());

let sessionRequest = 0;
function openSessionModal(sessionId, harness, finding, contextTitle) {
  sessionModal.querySelector('[data-slot="title"]').textContent = contextTitle || "Session detail";
  sessionModal.querySelector('[data-slot="sub"]').textContent = "";
  sessionModalBody.replaceChildren(loadingNote("loading session…"));
  sessionModal.showModal();
  loadSessionIntoModal(sessionId, harness, finding, ++sessionRequest);
}

async function loadSessionIntoModal(sessionId, harness, finding, requestId) {
  let detail;
  try {
    const qs = `id=${encodeURIComponent(sessionId)}&harness=${encodeURIComponent(harness || "")}&finding=${encodeURIComponent(finding || "abnormal token usage")}`;
    detail = await portalGetJson("/api/session?" + qs);
  } catch (err) {
    if (requestId !== sessionRequest || !sessionModal.open) return;
    sessionModalBody.replaceChildren(loadingNote("could not load session: " + ((err && err.message) || err)));
    return;
  }
  if (requestId !== sessionRequest || !sessionModal.open) return; // user closed it while the fetch was in flight

  const s = (lastSessionData.sessions || []).find((x) => x.session_id === sessionId && (!harness || x.harness === harness)) || {};
  const frag = document.createDocumentFragment();

  // 1. What this session was.
  const who = document.createElement("div");
  who.className = "sess-who";
  const when = s.first_ts ? new Date(s.first_ts).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" }) : null;
  who.innerHTML = `<div class="sess-fact"><span>Where</span><span>${esc(s.repo || "unknown")}${s.branch ? ` · ${esc(s.branch)}` : ""}</span></div>
    <div class="sess-fact"><span>Agent</span><span>${esc(s.harness || harness || "unknown")}</span></div>
    ${when ? `<div class="sess-fact"><span>When</span><span>${esc(when)}</span></div>` : ""}
    ${s.activity ? `<div class="sess-fact"><span>Activity</span><span>${esc(s.activity)}</span></div>` : ""}`;
  // Condition facts already supply repository and harness; retain the legacy facts only as a fallback.
  if (!lastSessionData.conditions) frag.appendChild(who);

  // 2+3. What happened + what to do (server-built deterministic findings; fallback to the one
  // finding text the page already has when the server couldn't compute rows).
  const findings = detail?.findings?.length ? detail.findings : capturedSessionFindings(lastSessionData, sessionId, harness);
  const whatHappened = document.createElement("div");
  whatHappened.className = "sess-findings";
  if (findings.length) {
    for (const f of findings) {
      const row = document.createElement("div");
      row.className = "sess-finding";
      row.innerHTML = `<p class="sess-finding-summary"><span class="sess-dot ${f.severity === "high" ? "dot-high" : "dot-warn"}"></span>${esc(f.summary)}</p>
        ${f.hint ? `<p class="sess-finding-hint">Fix: ${esc(f.hint)}</p>` : ""}
        <p class="sess-finding-jump">${f.section_key ? `<button type="button" class="sess-evidence-link" data-sec-key="${esc(f.section_key)}">see the evidence ↓</button>` : ""}</p>`;
      row.querySelector(".sess-evidence-link")?.addEventListener("click", () => {
        sessionModal.close();
        const section = document.querySelector(`#invest-sections details[data-sec-key="${f.section_key}"]`);
        if (section) scrollToSection(section);
      });
      whatHappened.appendChild(row);
    }
  } else {
    whatHappened.innerHTML = `<div class="sess-finding"><p class="sess-finding-summary"><span class="sess-dot dot-warn"></span>${esc(finding || "This session used more tokens than similar sessions.")}</p>
      <p class="sess-finding-hint">${detail && detail.found === false ? "The transcript is unavailable. Use the captured evidence and the agent prompt below to investigate." : ""}</p></div>`;
  }
  frag.appendChild(whatHappened);

  // 4. Copy prompt — the reusable copy button, source set to the server-built prompt. The label
  // is two words per the shared-button convention; a one-line note says what it does and why,
  // so the button isn't a mystery instruction.
  const actions = document.createElement("div");
  actions.className = "sess-actions";
  const copyBtn = document.createElement("portal-copy-button");
  copyBtn.setAttribute("label", "Copy prompt");
  copyBtn.copySource = detail.analysis_prompt || "";
  actions.appendChild(copyBtn);
  const why = document.createElement("p");
  why.className = "sess-why";
  why.textContent = "Paste into a fresh chat so your agent can investigate this session.";
  actions.appendChild(why);
  frag.appendChild(actions);

  // Heaviest turns — evidence, shown when the transcript is on disk. Dim list, no jargon framing.
  if (detail.found && (detail.heavy_turns || []).length) {
    const turns = document.createElement("details");
    turns.className = "sess-turns";
    turns.innerHTML = `<summary>Heaviest turns in this chat</summary>`;
    for (const t of detail.heavy_turns) {
      const row = document.createElement("div");
      row.className = "sess-turn";
      const size = t.result_chars != null ? tokShort(Math.round(t.result_chars / 4)) + " tokens in" : "";
      row.innerHTML = `<div class="sess-turn-head"><span class="tool">${esc(t.tool || t.event || "turn")}</span>${size ? `<span class="dim">${size}</span>` : ""}</div>
        ${t.preview ? `<div class="sess-turn-prev">${esc(t.preview)}</div>` : ""}`;
      turns.appendChild(row);
    }
    frag.appendChild(turns);
  }

  const conditionContext = sessionConditionLine(lastSessionData, sessionId, harness, { findings, fallbackFinding: finding, includeFacts: true });
  if (conditionContext) frag.prepend(conditionContext);
  sessionModalBody.replaceChildren(frag);
  sessionModal.querySelector('[data-slot="sub"]').textContent =
    (s.repo || "unknown") + (harness ? ` · ${harness}` : "");
}

function loadingNote(text) {
  const div = document.createElement("div");
  div.className = "sess-loading";
  div.textContent = text;
  return div;
}

// One delegated listener opens the popup for every session chip / Investigate row on the page.
// Chips render via sessionLink(); the handler looks up the session in the CURRENT report so the
// click always acts on live data. Called once, at module end (after lastSessionData's declaration).
function wireSessionChips() {
  document.addEventListener("click", (e) => {
    const chip = e.target.closest?.(".session-chip");
    if (!chip || chip.classList.contains("session-unknown")) return;
    const sessionId = chip.dataset.sessionId;
    if (!sessionId) return;
    e.preventDefault();
    const s = (lastSessionData.sessions || []).find((x) => x.session_id === sessionId && (x.harness ?? "") === (chip.dataset.harness ?? ""));
    const harness = s?.harness || chip.dataset.harness || "";
    const finding = chip.dataset.finding || `total ${s?.total_tokens ?? "?"} tokens — investigate why this session used so much context`;
    openSessionModal(sessionId, harness, finding, s?.title || null);
  });
}

// ── Timeline strip: WHEN did flagged events happen ──
// Marks-only — no day totals, no volume bars (that chart was removed as filler and stays gone).
// The plotted quantity is a FLAGGED EVENT (a spike turn or a loop start), so the only coloring
// question is which KIND of event it was — never a threshold comparison against a different unit.
// Each mark is a button that opens that session's drill-down popup; days with no flags render no
// mark at all. Hidden entirely when there are no flagged events — an empty strip is noise.
function renderTimelineStrip(data) {
  const sectionEl = document.getElementById("timeline-section");
  const strip = document.getElementById("timeline-strip");
  const legend = document.getElementById("timeline-legend");
  if (!sectionEl || !strip) return;

  const marks = [];
  // Spikes: one mark per spike turn (data.spikes is already deduped to worst-per-session with a
  // count; a session with 3 spikes gets one mark sized by count).
  for (const s of data.spikes || []) {
    marks.push({ ts: s.ts, kind: "spike", sessionId: s.session_id, harness: s.harness, count: s.spike_count || 1, label: `Spike — ${s.tool || "unknown tool"} · +${tokShort(s.delta_tokens)} tokens` });
  }
  for (const l of data.loops || []) {
    marks.push({ ts: l.ts, kind: "loop", sessionId: l.session_id, harness: l.harness, count: 1, label: `Loop — ${l.tool} ×${l.max_repeat}` });
  }
  marks.sort((a, b) => String(a.ts).localeCompare(String(b.ts)));

  if (!marks.length) {
    sectionEl.hidden = true;
    strip.replaceChildren();
    legend.textContent = "";
    return;
  }
  sectionEl.hidden = false;

  // One column per DAY that had at least one flag; marks stack vertically inside the day.
  // Day boundaries derive from the marks' own timestamps — no volume axis, no totals.
  const byDay = new Map();
  for (const m of marks) {
    const day = String(m.ts).slice(0, 10);
    if (!byDay.has(day)) byDay.set(day, []);
    byDay.get(day).push(m);
  }
  const days = [...byDay.keys()].sort();

  strip.replaceChildren();
  for (const day of days) {
    const col = document.createElement("div");
    col.className = "tl-day";
    for (const m of byDay.get(day)) {
      const btn = document.createElement("button");
      btn.type = "button";
      btn.className = `tl-mark tl-${m.kind}`;
      btn.title = `${m.label}${m.count > 1 ? ` (×${m.count})` : ""} — click to open the session`;
      btn.setAttribute("aria-label", btn.title);
      if (m.count > 1) btn.textContent = "×" + m.count;
      btn.addEventListener("click", () => {
        const s = (data.sessions || []).find((x) => x.session_id === m.sessionId && (x.harness ?? null) === (m.harness ?? null));
        openSessionModal(m.sessionId, m.harness || s?.harness || "", m.label, s?.title || null);
      });
      col.appendChild(btn);
    }
    const dayLabel = document.createElement("span");
    dayLabel.className = "tl-day-label";
    dayLabel.textContent = new Date(day + "T00:00:00").toLocaleDateString("en-US", { month: "short", day: "numeric" });
    col.appendChild(dayLabel);
    strip.appendChild(col);
  }
  legend.textContent = "red: spike turn · orange: runaway loop";
}

// Waste grade: color starts only where the user's danger line says it matters — below the first
// band the value renders in the DEFAULT color (a small deficit is still a deficit, not "good").
// Bands scale to the card's danger line (all-time 10%, this-week 16%): yellow at 1/3, orange 2/3,
// red at the line — the same 5/10/15 proportion as the original 15%-red scale.
function wasteGrade(pct, danger) {
  if (pct >= danger) return "grade-red";
  if (pct >= (danger * 2) / 3) return "grade-orange";
  if (pct >= danger / 3) return "grade-yellow";
  return "";
}

// One waste card: analytics-header style — range label, huge graded %, subtle tokens line, then
// the top-3 waste sources (each a link to its Investigate section) plus a "+N more" tooltip
// (shared tooltip component) listing every violator with its percent.
function wasteCard(label, total, parts, danger) {
  const div = document.createElement("div");
  div.className = "waste-card";
  const waste = parts.reduce((s, p) => s + p.tokens, 0);
  const share = total > 0 ? (waste / total) * 100 : 0;
  const grade = wasteGrade(share, danger);
  // Violators by share of the range's total usage, descending.
  const violators = parts
    .map((p) => ({ label: p.label, tokens: p.tokens, pct: total > 0 ? (p.tokens / total) * 100 : 0 }))
    .filter((v) => v.pct >= 0.05)
    .sort((a, b) => b.pct - a.pct);
  // Investigate-section each source links to (scroll + auto-expand).
  const secKeyByLabel = { "over-testing": "testing", "redundant reads": "reads", "runaway loops": "loops", "spike excess": "spikes" };
  const sourceHtml = (v) => {
    const g = wasteGrade(v.pct, danger);
    const key = secKeyByLabel[v.label] ? ` data-sec-key="${secKeyByLabel[v.label]}"` : "";
    return `<span class="waste-source${key ? " waste-source-link" : ""}"${key} tabindex="0"><span class="waste-pct-inline ${g}">${v.pct < 1 ? "<1" : Math.round(v.pct)}%</span> ${esc(v.label)}</span>`;
  };
  const shown = violators.slice(0, 3);
  const rest = violators.slice(3);
  // "+N more": click-persistent dropdown (visually a tooltip) listing ALL violators as clickable
  // jump links. Open/close handled by the delegated listeners in wireWasteSourceLinks.
  const moreHtml = rest.length
    ? `<span class="waste-more-wrap">
         <button type="button" class="waste-more" aria-expanded="false" aria-haspopup="true">+${rest.length} more</button>
         <span class="waste-pop" role="menu">${violators.map((v) => `<span class="waste-pop-row">${sourceHtml(v)}</span>`).join("")}</span>
       </span>`
    : "";

  // Column 1: range + big graded % + tokens. Column 2: the waste categories, one per row.
  div.innerHTML = `<span class="waste-range">${esc(label)}</span>
    <span class="waste-big ${grade}"><span class="waste-pct">${Math.round(share * 10) / 10}%</span><span class="waste-sub">${tokShort(waste)} of ${tokShort(total)} tokens</span></span>
    <span class="waste-sources">${shown.map((v) => `<span class="waste-source-row">${sourceHtml(v)}</span>`).join("")}${moreHtml}</span>`;
  return div;
}

// ── Layer 2: Action items (findings from deriveInsights) ──
function renderFindings(insights) {
  const container = document.getElementById("findings");
  container.replaceChildren();
  if (!insights || !insights.length) {
    container.appendChild(emptyMsg("not enough data yet for conclusions"));
    return;
  }
  for (const f of insights.slice(0, 8)) {
    container.appendChild(findingCard(f));
  }
}

// Insight kind → the Investigate section (data-sec-key) that holds its evidence. Findings whose
// kind has no matching section keep PLAIN next-action text — no manufactured links.
const FINDING_SECTION = {
  spike_tail_risk: "spikes",
  dominant_cost: "group-cost",
  runaway_loop: "loops",
  midpoint_regression: "regression",
  heaviest_tool: "group-cost",
};

function findingCard(f) {
  const sevClass = f.severity === "high" ? "sev-high" : f.severity === "warn" ? "sev-warn" : "sev-info";
  const confClass = f.confidence === "strong signal" ? "strong" : "";
  const card = document.createElement("div");
  card.className = "finding";
  // The suggested next step is repeated in the evidence section, so the card keeps only a
  // bookmark link to it. It reuses .waste-source-link's jump-click contract (scroll + expand).
  const secKey = FINDING_SECTION[f.kind] || null;
  const jumpHtml = secKey
    ? ` <span class="finding-jump waste-source-link" data-sec-key="${esc(secKey)}" tabindex="0" role="link" aria-label="jump to the evidence section">see evidence ↓</span>`
    : "";
  card.innerHTML = `<div class="finding-top">
      <div class="severity ${sevClass}"></div>
      <div class="finding-body">
        <h3 class="finding-title">${esc(f.headline)}
          ${f.confidence ? `<span class="confidence ${confClass}">${esc(f.confidence)}</span>` : ""}
        </h3>
        <p class="finding-evidence">${esc(f.detail || "")}${jumpHtml}</p>
      </div>
    </div>`;
  return card;
}

// ── Layer 4: Investigation sections ──
function renderInvestigationSections(data) {
  const container = document.getElementById("invest-sections");
  container.replaceChildren();

  // 4a: Spike causes — badge is a count, enough to prompt opening.
  if (data.spike_causes?.length) {
    container.appendChild(investSection({
      key: "spikes",
      title: "What made tokens jump",
      framing: "spikes grouped by the behavior behind them",
      badge: `${data.spike_causes.length} spike${data.spike_causes.length > 1 ? "s" : ""}`,
      badgeClass: "alert",
      badgeTip: BADGE_TIPS.alert,
      bodyEl: spikeCausesBody(data.spike_causes),
    }));
  }

  // 4b: Spike anatomy
  if (data.spike_anatomy?.groups?.length) {
    container.appendChild(investSection({
      key: "spike-prone",
      title: "Which tools are spike-prone",
      framing: "lift > 1 = the group shows up in spikes more than in normal turns",
      badge: `${data.spike_anatomy.groups.length} group${data.spike_anatomy.groups.length > 1 ? "s" : ""}`,
      badgeClass: "warn",
      badgeTip: BADGE_TIPS.warn,
      bodyEl: spikeAnatomyBody(data.spike_anatomy),
    }));
  }

  // 4c: Loops
  if (data.loops?.length) {
    container.appendChild(investSection({
      key: "loops",
      title: "Tools that got stuck",
      framing: "same tool fired repeatedly in a row",
      badge: `${data.loops.length} loop${data.loops.length > 1 ? "s" : ""}`,
      badgeClass: "alert",
      badgeTip: BADGE_TIPS.alert,
      bodyEl: loopsBody(data.loops, data),
    }));
  }

  // 4d: Read warnings — grouped by TYPE (one collapsible item per warning type), each type's
  // instances listed inside it. The per-row list didn't scale: same-type rows repeated the same
  // label + hint, so N warnings read as N-1 duplicates.
  if (data.read_warnings?.length) {
    container.appendChild(investSection({
      key: "reads",
      title: "Context bloat from reads",
      framing: "large or repeated document reads",
      badge: `${data.read_warnings.length} warning${data.read_warnings.length > 1 ? "s" : ""}`,
      badgeClass: "warn",
      badgeTip: BADGE_TIPS.warn,
      bodyEl: readWarningsBody(data.read_warnings, data),
    }));
  }

  // 4e: Cost by tool group — evidence panel with one warn condition: a group taking ≥40% of ALL
  // tool tokens is dominant (same threshold the Action-items dominant-cost finding uses). Below
  // that, "biggest group" is not actionable on its own — the badge stays a neutral count.
  if (data.group_cost?.length) {
    const byShare = [...data.group_cost].sort((a, b) => (b.share_of_tokens || 0) - (a.share_of_tokens || 0));
    const top = byShare[0];
    const topShare = Math.round((top.share_of_tokens || 0) * 100);
    const dominant = topShare >= 40;
    container.appendChild(investSection({
      key: "group-cost",
      title: "Which tool groups cost the most?",
      framing: "share of tool tokens by group; flagged when one group takes ≥40%",
      badge: dominant ? `${top.group} (${topShare}%)` : `${data.group_cost.length} group${data.group_cost.length > 1 ? "s" : ""}, none dominant`,
      badgeClass: dominant ? "warn" : "ok",
      badgeTip: dominant ? BADGE_TIPS.warn : BADGE_TIPS.ok,
      bodyEl: costComparisonBody(data.group_cost, data.tool_cost),
    }));
  }

  // 4f: Regression — % share framing. First-half vs last-half share of tool tokens: a group can
  // only gain share by growing relative to everything else, so a share gain IS "got more
  // expensive relative to your overall trends". Raw token moves stay as secondary detail.
  if (data.regression?.groups?.length) {
    const byShareGain = [...data.regression.groups].sort(
      (a, b) => ((b.after_share ?? 0) - (b.before_share ?? 0)) - ((a.after_share ?? 0) - (a.before_share ?? 0)),
    );
    const top = byShareGain[0];
    const hasRegression = (top.after_share ?? 0) - (top.before_share ?? 0) > 0;
    const bShare = pct(top.before_share ?? 0);
    const aShare = pct(top.after_share ?? 0);
    container.appendChild(investSection({
      key: "regression",
      title: "Did anything get more expensive?",
      framing: "each group's share of tool tokens, first half vs last half",
      badge: hasRegression ? `${top.group} → ${bShare}% → ${aShare}%` : "none found",
      badgeClass: hasRegression ? "warn" : "ok",
      badgeTip: hasRegression ? BADGE_TIPS.warn : BADGE_TIPS.ok,
      bodyEl: regressionBody(data.regression),
    }));
  }

  // 4g: Testing efficiency — badge is the direct yes/no the question asks; the number lives in
  // the body. Threshold: ≥10% token share = yes (waste line's yellow band). Info icon → the
  // guide's Testing Efficiency section, which describes exactly this panel (incl. the two
  // sub-metrics below).
  if (data.testing_efficiency) {
    const te = data.testing_efficiency;
    const tokenShare = te["test.token_share"];
    if (tokenShare != null) {
      const overTesting = tokenShare >= 10;
      container.appendChild(investSection({
        key: "testing",
        title: "Are you over-testing?",
        framing: "share of tokens spent on test runs and full-suite reruns",
        badge: overTesting ? `yes — ${tokenShare}%` : `no — ${tokenShare}%`,
        badgeClass: overTesting ? "warn" : "ok",
        badgeTip: overTesting ? BADGE_TIPS.warn : BADGE_TIPS.ok,
        bodyEl: testingEfficiencyBody(te),
        docAnchor: "testing-efficiency",
      }));
    }
  }

  // 4h (removed): "Before vs after your change" marker comparison — half an idea on its own;
  // a future iteration will address change-marking holistically. The pipeline fields
  // (marker_comparison, MOCK_MARKER) stay — the CLI still reads them.
}

// Badge color rule (one rule for every Investigate section):
//   red    — measured incidents: turns or loops that already cost extra tokens
//   yellow — a pattern worth a look (share, lift, read or testing thresholds crossed)
//   green  — checked, nothing flagged
const BADGE_TIPS = {
  alert: "Red: incidents that already cost extra tokens.",
  warn: "Yellow: a pattern worth a look, not a confirmed loss.",
  ok: "Green: checked, nothing flagged.",
};

function investSection({ key, title, framing, badge, badgeClass, badgeTip, bodyEl, docAnchor }) {
  const details = document.createElement("details");
  details.className = "invest-section";
  if (key) details.dataset.secKey = key;
  // Info icon (optional): opens the shared doc-guide popup at the section's anchor. Only set
  // docAnchor where the guide genuinely describes this section — no icon beats a wrong one.
  const iconHtml = docAnchor
    ? `<portal-info-icon data-doc-anchor="${esc(docAnchor)}" aria-haspopup="dialog" aria-expanded="false" aria-label="what this section means" title="what this section means"></portal-info-icon>`
    : "";
  details.innerHTML = `<summary>
    <span class="chev">▸</span>
    <span class="invest-head">
      <span class="invest-title">${esc(title)} ${iconHtml}</span>
      <span class="invest-framing">${esc(framing)}</span>
    </span>
    <span class="invest-badge ${badgeClass}"${badgeTip ? ` title="${esc(badgeTip)}"` : ""}>${esc(badge)}</span>
  </summary>
  <div class="invest-body"></div>`;
  const body = details.querySelector(".invest-body");
  body.appendChild(bodyEl);
  return details;
}

function spikeCausesBody(rows) {
  const frag = document.createDocumentFragment();
  for (const c of rows.slice(0, 8)) {
    frag.appendChild(itemRow({
      dotColor: "var(--danger)",
      head: `${causeLabel(c.cause)} (${c.spikes} spike${c.spikes > 1 ? "s" : ""})`,
      detail: `Worst <span class="num">+${tokShort(c.worst_delta)}</span> in <code>${esc(c.worst_repo || "unknown")}</code> · avg <span class="num">${tokShort(c.avg_delta)}</span> per spike`,
      hint: c.hint,
    }));
  }
  return frag;
}

function spikeAnatomyBody(a) {
  const frag = document.createDocumentFragment();
  for (const g of a.groups.slice(0, 8)) {
    const liftColor = g.lift >= 5 ? "var(--danger)" : g.lift >= 1 ? "var(--warn)" : "var(--ok)";
    frag.appendChild(itemRow({
      dotColor: liftColor,
      head: `${esc(g.group)} — lift ${g.lift == null ? "only in spikes" : g.lift + "×"}`,
      detail: `<span class="num">${pct(g.spike_share)}%</span> of spike turns vs <span class="num">${pct(g.normal_share)}%</span> of normal turns · avg <span class="num">${tokShort(g.avg_tokens)}</span> tokens/call`,
      hint: g.lift >= 1 ? `Scope ${esc(g.group)} calls more narrowly (smaller query, fewer refs) before they land in context.` : "Below baseline — not a spike driver.",
    }));
  }
  return frag;
}

function loopsBody(rows, data) {
  const frag = document.createDocumentFragment();
  for (const l of rows.slice(0, 10)) {
    frag.appendChild(itemRow({
      dotColor: "var(--danger)",
      head: `${esc(l.tool)} repeated ${l.max_repeat}× — ${esc(l.repo)}`,
      detail: `Session: ${sessionLink(l.session_id, l.harness, data, l.context?.title ? `"${l.context.title}"` : null)}`,
      hint: l.hint,
    }));
  }
  return frag;
}

// Read warnings grouped by TYPE: one item-row per warning type, instances as an internal list
// inside it, hint shown once. Cap the internal list at 5 instances with a "+N more" tail.
function readWarningsBody(rows, data) {
  const frag = document.createDocumentFragment();
  const byType = new Map();
  for (const w of rows) {
    if (!byType.has(w.type)) byType.set(w.type, []);
    byType.get(w.type).push(w);
  }
  // Types sorted by combined token weight, heaviest first.
  const types = [...byType.entries()]
    .map(([type, list]) => ({ type, list, tokens: list.reduce((s, w) => s + (w.approx_tokens || 0), 0) }))
    .sort((a, b) => b.tokens - a.tokens);
  for (const { type, list } of types) {
    const totalTokens = list.reduce((s, w) => s + (w.approx_tokens || 0), 0);
    const totalReads = list.reduce((s, w) => s + (w.read_count || 1), 0);
    const instances = list.slice(0, 5);
    const overflow = list.length - instances.length;
    const instanceLines = instances.map((w) =>
      `<div class="read-instance">${esc(w.repo || "unknown")} · <span class="num">${tokShort(w.approx_tokens)}</span> approx tokens · ${w.read_count || 1} read${(w.read_count || 1) > 1 ? "s" : ""} · Session: ${sessionLink(w.session_id, w.harness, data)}</div>`,
    ).join("");
    frag.appendChild(itemRow({
      dotColor: type === "large_document_read" ? "var(--warn)" : "var(--danger)",
      head: `${readWarningLabel(type)} <span class="read-type-meta">— ${tokShort(totalTokens)} approx tokens · ${totalReads} total reads · ${list.length} instance${list.length > 1 ? "s" : ""}</span>`,
      detail: `<div class="read-instances">${instanceLines}${overflow > 0 ? `<div class="read-instance read-more">+${overflow} more</div>` : ""}</div>`,
      hint: docLookupHint(list[0], type),
    }));
  }
  return frag;
}

// Capability-aware doc-lookup hint — package-agnostic by construction. The three states:
//   1) a doc-lookup package is INSTALLED (live config) or already used in this session's data
//      → name it, framed as "already available, use it" (no install suggestion);
//   2) one is AVAILABLE in the catalog but not installed → mention it by name + install link;
//   3) none known → agnostic advice, no package reference.
// Package identity comes from /api/config's package list (id/label + self-declared capabilities),
// never from a hardcoded name here. Falls back to the state-3 copy when config isn't loaded.
function docLookupHint(warning, type) {
  const cfg = window.__tokensConfig;
  const pkgs = (cfg?.packages || []).filter((p) => (p.capabilities || []).includes("doc-lookup"));
  if (!pkgs.length) return readWarningLabel(type) === "Large document read"
    ? "prefer a section-level lookup over loading the whole document"
    : "reuse the earlier result or look up only the needed section";
  const sessionUsed = warning.context?.mcp_servers_used || [];
  const installed = pkgs.find((p) => p.status === "enabled" || p.status === "configured" || sessionUsed.includes(p.id));
  if (installed) {
    return `a doc index is already installed (${installed.label}) — pull only the section you need instead of the full file`;
  }
  const available = pkgs[0];
  // Plain text, not an anchor: itemRow escapes the hint (and the agent prompt interpolates it as
  // raw text), so embedded HTML would render as a literal tag. The label name + install guidance
  // are preserved; /config is one click away in the page nav.
  return `a doc index would serve just the section you need — ${available.label} is available but not installed`;
}

function costComparisonBody(groupCost, toolCost) {
  // Bar chart (shared <portal-bar-chart>): one bar per group, sized by share of all tool tokens.
  // Heaviest/cheapest per-call groups are highlighted by data, not hardcoded names. Underneath, a
  // real table gives every group (and its top tools) the same columns so numbers line up.
  const sorted = [...groupCost].sort((a, b) => (b.total_tokens || 0) - (a.total_tokens || 0)).slice(0, 8);
  const perCallRanked = [...groupCost].sort((a, b) => b.avg_tokens - a.avg_tokens);
  const heaviest = perCallRanked[0]?.group;
  const cheapest = perCallRanked[perCallRanked.length - 1]?.group;
  const tagOf = (g) => (sorted.length > 1 && g === heaviest ? "heaviest" : sorted.length > 1 && g === cheapest ? "cheapest" : "");

  const chart = document.createElement("portal-bar-chart");
  chart.rows = sorted.map((g) => ({
    label: g.group,
    value: g.share_of_tokens || 0,
    text: Math.round((g.share_of_tokens || 0) * 100) + "%",
    tone: tagOf(g.group) === "heaviest" ? "warn" : tagOf(g.group) === "cheapest" ? "ok" : "",
  }));

  // Per-tool rows show WHICH tool inside a heavy group to scope: top 3 by avg tokens per call.
  let body = "";
  for (const g of sorted) {
    const tag = tagOf(g.group);
    body += `<tr class="cost-group-row">
      <th scope="row">${esc(g.group)}${tag ? ` <span class="tag ${tag}">${tag}</span>` : ""}</th>
      <td>${fmt(g.calls)}</td><td>${tokShort(g.total_tokens)}</td><td>${tokShort(g.avg_tokens)}</td><td></td>
    </tr>`;
    const tools = (toolCost || []).filter((t) => t.group === g.group).sort((a, b) => b.avg_tokens - a.avg_tokens).slice(0, 3);
    for (const t of tools) {
      body += `<tr class="cost-tool-row">
        <th scope="row">${esc(t.tool)}</th>
        <td>${fmt(t.calls)}</td><td>${tokShort(t.total_tokens)}</td><td>${tokShort(t.avg_tokens)}</td><td>${tokShort(t.max_tokens)}</td>
      </tr>`;
    }
  }
  const table = document.createElement("table");
  table.className = "cost-table";
  table.innerHTML = `<thead><tr><th scope="col">Group / tool</th><th scope="col">Calls</th><th scope="col">Total</th><th scope="col">Avg / call</th><th scope="col">Max / call</th></tr></thead><tbody>${body}</tbody>`;

  const frag = document.createDocumentFragment();
  frag.appendChild(chart);
  frag.appendChild(table);
  return frag;
}

function regressionBody(r) {
  const frag = document.createDocumentFragment();
  // Primary column = share of tool tokens (first half → last half); per-call tokens demoted to
  // the detail column. Rows sorted by share gain, biggest gainer first. A header row labels every
  // column — the before/after pair is meaningless without knowing what unit it's in.
  const sorted = [...r.groups].sort(
    (a, b) => ((b.after_share ?? 0) - (b.before_share ?? 0)) - ((a.after_share ?? 0) - (a.before_share ?? 0)),
  );
  const table = document.createElement("div");
  table.className = "reg-table";
  table.innerHTML = `<div class="reg-row reg-head" role="row">
      <span class="reg-group">tool group</span>
      <span class="reg-col">first half</span>
      <span class="reg-arrow"></span>
      <span class="reg-col">last half</span>
      <span class="reg-col">this week</span>
      <span class="reg-detail">avg tok/call</span>
    </div>`;
  for (const g of sorted.slice(0, 8)) {
    const row = document.createElement("div");
    row.className = "reg-row";
    const gain = (g.after_share ?? 0) - (g.before_share ?? 0);
    const dir = (d) => (d > 0 ? "up" : d < 0 ? "down" : "");
    // First half is the baseline (neutral); last half and this week are judged against it.
    const deltaClass = dir(gain);
    const weekClass = g.week_share == null ? "" : dir((g.week_share ?? 0) - (g.before_share ?? 0));
    row.innerHTML = `<span class="reg-group">${esc(g.group)}</span>
      <span class="reg-col">${pct(g.before_share ?? 0)}%</span>
      <span class="reg-arrow">→</span>
      <span class="reg-col reg-after ${deltaClass}">${pct(g.after_share ?? 0)}%</span>
      <span class="reg-col ${weekClass}">${pct(g.week_share ?? 0)}%</span>
      <span class="reg-detail">${tokShort(g.before_avg_tokens)} → ${tokShort(g.after_avg_tokens)}</span>`;
    table.appendChild(row);
  }
  frag.appendChild(table);
  if (r.exploratory) {
    const note = document.createElement("p");
    note.className = "item-detail";
    note.style.margin = "8px 0 0";
    note.innerHTML = `<strong>Exploratory:</strong> midpoint split, not tied to a change. For a precise before/after, mark a change in <a href="#condition-changes-section">Your changes</a>.`;
    frag.appendChild(note);
  }
  return frag;
}

function testingEfficiencyBody(te) {
  const frag = document.createDocumentFragment();
  const tokenShare = te["test.token_share"];
  const fullPerActiveSession = te["test.full_suite_calls_per_testing_session"];
  const redundant = te["test.full_suite_without_intervening_edit"];
  const redundantRounded = Math.round(redundant);
  frag.appendChild(itemRow({
    dotColor: redundant >= 1 ? "var(--warn)" : "var(--accent)",
    head: fullPerActiveSession != null && fullPerActiveSession >= 1
      ? `Full suite run ${fullPerActiveSession.toFixed(1)}× per session with any testing`
      : `Full suite run less than once per testing session`,
    detail: `<span class="num">${tokenShare != null ? tokenShare : "—"}%</span> of all captured tokens went to testing${redundantRounded >= 1 ? ` · <span class="num">${redundantRounded}</span> full-suite rerun${redundantRounded === 1 ? "" : "s"} without an intervening edit` : ""}.`,
    hint: "Run targeted tests (single file or --filter) between edits — save the full suite for the end.",
  }));
  // Second item row: the remaining testing sub-metrics, each with its honest null state and
  // honest rounding (a clause that rounds to zero is hidden, not printed as 0 — same treatment
  // as the fractional rates above). targeted_to_full_ratio is a RATIO, not a percent.
  const unchangedFailures = te["test.full_suite_unchanged_failure_signature"];
  const targetedRatio = te["test.targeted_to_full_ratio"];
  const subParts = [];
  if (unchangedFailures != null && Math.round(unchangedFailures) >= 1) {
    subParts.push(`<span class="num">${Math.round(unchangedFailures)}</span> full-suite rerun${Math.round(unchangedFailures) === 1 ? "" : "s"} got the same failure as before — nothing changed, but the suite ran anyway`);
  }
  if (targetedRatio != null) {
    // Round honestly: <0.05 shows "<0.05", never a silent 0.
    const shown = targetedRatio < 0.05 ? "&lt;0.05" : targetedRatio.toFixed(targetedRatio < 10 ? 2 : 0);
    subParts.push(`you run <span class="num">${shown}</span> targeted runs for every full-suite run${targetedRatio < 1 ? " — mostly full suites" : ""}`);
  }
  if (subParts.length) {
    frag.appendChild(itemRow({
      dotColor: unchangedFailures >= 1 ? "var(--danger)" : "var(--accent)",
      head: "Testing pattern detail",
      // The clauses are internal templates (same trust level as every other detail string in
      // itemRows) — no per-clause escaping, matching the file's existing convention.
      detail: subParts.join(" · "),
      hint: null,
    }));
  }
  return frag;
}

function itemRow({ dotColor, head, detail, hint }) {
  const row = document.createElement("div");
  row.className = "item-row";
  row.innerHTML = `<div class="item-dot" style="background:${dotColor}"></div>
    <div class="item-body">
      <p class="item-head">${head}</p>
      ${detail ? `<p class="item-detail">${detail}</p>` : ""}
      ${hint ? `<p class="item-hint">${esc(hint)}</p>` : ""}
    </div>`;
  return row;
}

// ── Layer 5: Agent-ready prompt (the distilled report, reformatted as a copy-paste prompt) ──
function renderAgentPrompt(data) {
  const textEl = document.getElementById("agent-prompt-text");

  const lines = [];
  // Harness list is dynamic — machine-installed harnesses from /api/config (same machineHarnesses
  // cohort the setup cascade uses), not a static string. Falls back to the data's own harnesses.
  const installedNames = activePresentedHarnesses(window.__tokensConfig || {})
    .map((h) => h.displayName || h.id);
  const dataNames = [...new Set((data.harnesses || []).filter(Boolean))];
  const names = installedNames.length ? installedNames : dataNames;
  const harnessList = names.length ? formatHarnessList(names) : "my AI coding agent";
  lines.push(`I've been tracking token usage across my AI coding agent sessions (${harnessList}).`);
  lines.push("Below is my deterministic token telemetry report for the current period — every number comes from");
  lines.push("my actual tool-call captures, not estimates. I want to cut down token waste and cost without");
  lines.push("slowing down my workflow. Please:");
  lines.push("");
  lines.push("1. Identify the top 2-3 concrete changes I should make (e.g. scoping MCP queries tighter,");
  lines.push("   reading fewer/smaller files, stopping runaway tool loops, running targeted tests instead of");
  lines.push("   full suites). For each, quantify the expected token savings from the data below.");
  lines.push("2. Call out anything that looks anomalous or like a regression I may not have noticed.");
  lines.push("3. Suggest a measurement or marker I could set up to verify each change actually helped.");
  lines.push("");
  lines.push("=== TOKEN TELEMETRY REPORT ===");
  lines.push("");
  lines.push(`Period: ${data.conditions.data_quality.sessions} observed sessions (${(data.sessions || []).length} with token data), ${(data.capture_count || 0)} tool-call captures.`);
  const spikeCount = (data.spikes || []).length;
  if (spikeCount) lines.push(`Usage spikes: ${spikeCount} turns exceeded the ${tokShort(data.spike_threshold)} per-turn spike threshold (2σ above the mean).`);
  const sevenDay = data.usage_windows?.seven_day;
  if (sevenDay) lines.push(`Total usage: ${tokShort(sevenDay)} tokens over the trailing 7-day window.`);

  if (data.spike_causes?.length) {
    lines.push("");
    lines.push("What drove the spikes (with the recommended fix for each):");
    for (const c of data.spike_causes.slice(0, 5)) {
      lines.push(`  - ${causeLabel(c.cause)}: ${c.spikes} spike${c.spikes > 1 ? "s" : ""}, worst +${tokShort(c.worst_delta)} tokens in ${c.worst_repo || "unknown"} (avg ${tokShort(c.avg_delta)}/spike)`);
      if (c.hint) lines.push(`      Fix: ${c.hint}`);
    }
  }
  if (data.spike_anatomy?.groups?.length) {
    lines.push("");
    lines.push("Spike-prone tool groups (lift = how much more a group appears in spike turns vs normal turns):");
    for (const g of data.spike_anatomy.groups.slice(0, 6)) {
      lines.push(`  - ${g.group}: lift ${g.lift == null ? "only in spikes" : g.lift + "×"}, in ${pct(g.spike_share)}% of spike turns vs ${pct(g.normal_share)}% of normal turns (${tokShort(g.avg_tokens)} tokens/call in spikes)`);
      if (g.lift >= 1) lines.push(`      Fix: scope ${g.group} calls more narrowly (smaller query, fewer refs) before they land in context.`);
    }
  }
  if (data.loops?.length) {
    lines.push("");
    lines.push("Runaway tool loops (same tool fired many times consecutively in one session):");
    for (const l of data.loops.slice(0, 5)) {
      lines.push(`  - ${l.tool} fired ${l.max_repeat}× consecutively in ${l.repo}${l.context?.title ? ` (session: "${l.context.title}")` : ""}`);
      if (l.hint) lines.push(`      Fix: ${l.hint}`);
    }
  }
  if (data.read_warnings?.length) {
    lines.push("");
    lines.push("Context bloat from document reads (grouped by type):");
    const byType = new Map();
    for (const w of data.read_warnings) {
      if (!byType.has(w.type)) byType.set(w.type, []);
      byType.get(w.type).push(w);
    }
    for (const [type, list] of byType) {
      const tokens = list.reduce((s, w) => s + (w.approx_tokens || 0), 0);
      lines.push(`  - ${readWarningLabel(type)}: ${tokShort(tokens)} approx tokens across ${list.length} instance${list.length > 1 ? "s" : ""}`);
      for (const w of list.slice(0, 3)) {
        lines.push(`      · ${w.repo || "unknown"}: ${tokShort(w.approx_tokens)} tokens, ${w.read_count || 1} read${(w.read_count || 1) > 1 ? "s" : ""}`);
      }
      const hint = list[0]?.hint;
      if (hint) lines.push(`      Fix: ${hint}`);
    }
  }
  if (data.group_cost?.length) {
    lines.push("");
    lines.push("Tool-group cost as share of all tool tokens:");
    for (const g of data.group_cost.slice(0, 8)) {
      lines.push(`  - ${g.group}: ${Math.round((g.share_of_tokens || 0) * 100)}% of tool tokens (${tokShort(g.avg_tokens)}/call over ${g.calls} calls, ${tokShort(g.total_tokens)} total)`);
    }
  }
  if (data.testing_efficiency) {
    const te = data.testing_efficiency;
    const tokenShare = te["test.token_share"];
    const redundant = te["test.full_suite_without_intervening_edit"];
    if (tokenShare != null) {
      lines.push("");
      lines.push(`Testing: ${tokenShare}% of all captured tokens went to test runs.`);
      if (redundant != null && redundant > 0) {
        lines.push(`  - ${redundant.toFixed(1)} full-suite reruns per session happened without an intervening edit (likely redundant).`);
      }
    }
  }
  if (data.insights?.length) {
    lines.push("");
    lines.push("Deterministic findings from the analysis pipeline:");
    for (const f of data.insights) {
      lines.push(`  - [${f.severity}] ${f.headline}`);
      if (f.detail) lines.push(`      ${f.detail}`);
      if (f.next_action) lines.push(`      Suggested next step: ${f.next_action}`);
    }
  }

  const promptText = lines.join("\n");
  textEl.textContent = promptText;

  // Reusable shared copy button (<portal-copy-button>, same as plans/developer-runtime) — set the
  // copy source lazily; the element handles the copied-state UI itself.
  const copyBtn = document.getElementById("agent-prompt-copy");
  if (copyBtn) copyBtn.copySource = promptText;
}

// ── Layer 6: Full data (demoted) ──
function renderFullData(data) {
  const container = document.getElementById("fulldata-content");
  container.replaceChildren();

  // Data quality notice + the actual warnings (per-harness rows) — the old dead "view details"
  // link is gone; the details render right here.
  if (data.data_quality_warnings?.length) {
    const notice = document.createElement("div");
    notice.className = "dq-notice";
    notice.innerHTML = `<span class="dq-icon">⚠</span><span>Data quality: ${data.data_quality_warnings.length} warning${data.data_quality_warnings.length > 1 ? "s" : ""} — some events may have incomplete token data.</span>`;
    container.appendChild(notice);
    container.appendChild(rawTable("Data quality warnings", ["harness", "warning", "events", "detail"],
      data.data_quality_warnings.slice(0, 10).map((w) => [
        esc(w.harness || "unknown"),
        esc(w.type),
        { num: w.events ?? w.token_records ?? 0 },
        esc(w.hint || ""),
      ]),
    ));
  }

  // Top sessions.
  if (data.sessions?.length) {
    container.appendChild(rawTable("Top sessions by tokens", ["session", "repo", "tokens", "captures"],
      data.sessions.slice(0, 10).map((s) => [
        { html: sessionLink(s.session_id, s.harness, data, s.title || s.session_id?.slice(0, 8)) },
        esc(s.repo || "unknown"),
        { num: tokShort(s.total_tokens) },
        { num: s.captures || 0 },
      ]),
    ));
  }
  // Top tools.
  if (data.top_tools?.length) {
    container.appendChild(rawTable("Top tools by tokens", ["tool", "calls", "tokens"],
      data.top_tools.slice(0, 10).map((t) => [
        esc(t.key), { num: t.captures }, { num: tokShort(t.tokens) },
      ]),
    ));
  }

  // Top repos.
  if (data.top_repos?.length) {
    container.appendChild(rawTable("Top repos by tokens", ["repo", "captures", "tokens"],
      data.top_repos.slice(0, 10).map((r) => [
        esc(r.key), { num: r.captures }, { num: tokShort(r.tokens) },
      ]),
    ));
  }

  // Per-package cost (MCP servers + a synthetic "native" bucket) and top MCP servers — demoted
  // raw tables, neutral numbers (the MCP-vs-native NARRATIVE stays out; the data stays visible).
  if (data.package_cost?.length) {
    container.appendChild(rawTable("Cost per package", ["package", "calls", "avg tokens/call", "total tokens"],
      data.package_cost.slice(0, 10).map((p) => [
        esc(p.package || "unknown"), { num: p.calls }, { num: tokShort(p.avg_tokens) }, { num: tokShort(p.total_tokens) },
      ]),
    ));
  }
  if (data.top_mcp?.length) {
    container.appendChild(rawTable("Top MCP servers by tokens", ["server", "captures", "tokens"],
      data.top_mcp.slice(0, 10).map((m) => [
        esc(m.key), { num: m.captures }, { num: tokShort(m.tokens) },
      ]),
    ));
  }
}

function rawTable(title, headers, rows) {
  const div = document.createElement("div");
  div.className = "raw-table";
  const thead = headers.map((h) => `<th>${esc(h)}</th>`).join("");
  const tbody = rows.map((r) => `<tr>${r.map((c) => {
    // Trusted HTML (e.g. session chips with their tooltips) passes through as {html};
    // plain strings get escaped like everything else.
    if (typeof c === "object" && c !== null) {
      if (c.html != null) return `<td>${c.html}</td>`;
      if (c.num != null) return `<td class="num">${esc(String(c.num))}</td>`;
    }
    return `<td>${esc(String(c))}</td>`;
  }).join("")}</tr>`).join("");
  div.innerHTML = `<h3>${esc(title)}</h3><div class="raw-table-scroll"><table><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
  return div;
}

// ── Session links: dynamic chip per session reference ──
// When the session exists in the report (data.sessions), render a chip with a rich tooltip of
// human-friendly session context (what it was about, what it did, where, when). When it doesn't,
// fall back to the plain static label. One code path — no per-session markup.
function sessionLink(sessionId, harness, data, fallbackLabel) {
  const id = sessionId || "";
  const s = (data.sessions || []).find((x) => x.session_id === id && (x.harness ?? null) === (harness ?? null));
  const label = fallbackLabel || id.slice(0, 8);
  if (!s) return `<span class="session-chip session-unknown"><code>${esc(label)}</code></span>`;
  // data-session-id is the click target — wireSessionChips' delegated listener opens the
  // drill-down popup for any chip carrying it. Deliberately NO hover tooltip: the chip's only
  // action is the popup, so hovering shouldn't imply the hover card is the whole story — and the
  // popup carries everything the tooltip did, plus findings + the agent prompt.
  return `<span class="session-chip session-link" data-session-id="${esc(id)}" data-harness="${esc(s.harness || "")}" tabindex="0" role="button" aria-label="open session detail"><code>${esc(label)}</code></span>`;
}

// One-time delegated listeners: waste-source links, session-chip drill-down, doc-guide info
// icons, "+N more" dropdown, sticky-header measure. Declared functions hoist, but the
// `let stickyHeaderOffset` they touch does not — so the calls sit here, after every declaration,
// at module end.
wireWasteSourceLinks();
wireSessionChips();
wireDocGuideIcons();
wireHintToggle();

// ── Doc-guide info icons ──
// Same one-delegate pattern as the v1 dashboard: any <portal-info-icon data-doc-anchor> opens
// the shared doc-guide popup pre-scrolled to that heading. The guide is server-rendered from
// docs/user/guides/telemetry.md — the popup and the on-disk doc are always the same content.
// Anchors are placed only where the guide section genuinely describes the tokens section
// (testing-efficiency, session-detail); sections the guide doesn't cover get NO icon rather
// than a mismatched one.
const docModal = createDocGuideModal(document.getElementById("tokensdocmodal"), async () => {
  try {
    return await portalGetJson("/api/telemetry/guide");
  } catch (err) {
    return { ok: false, error: (err && err.message) || String(err) };
  }
});
document.getElementById("tokensdocmodal").addEventListener("close", () => {
  for (const icon of document.querySelectorAll("portal-info-icon[aria-expanded='true']")) {
    icon.setAttribute("aria-expanded", "false");
  }
});
function wireDocGuideIcons() {
  document.addEventListener("click", (event) => {
    const trigger = event.target.closest("portal-info-icon[data-doc-anchor]");
    if (!trigger) return;
    trigger.setAttribute("aria-expanded", "true");
    docModal.open(trigger.dataset.docAnchor);
  });
}

// ── Helpers ──
function emptyMsg(msg) {
  const div = document.createElement("div");
  div.className = "empty-msg";
  div.textContent = msg;
  return div;
}

function causeLabel(cause) {
  const labels = {
    "mcp-bundle": "MCP bundle too large",
    "context-accumulation": "Context accumulation across many turns",
    "large-file-read": "Large file read",
    "unbounded-bash-output": "Unbounded Bash output",
    "big-prompt": "Large prompt",
    "large-tool-output": "Large tool output",
  };
  return labels[cause] || cause;
}

function readWarningLabel(type) {
  const labels = {
    "large_document_read": "Large document read",
    "repeated_document_read": "Repeated document read",
    "stale_doc_lookup": "Stale doc lookup",
    "mixed_code_lookup": "Mixed code lookup",
  };
  return labels[type] || type;
}
