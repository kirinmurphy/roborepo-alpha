// Harness adapters: translate Claude and Codex source payloads into the normalized usage snapshot.
// Pure — no I/O. Absent source values stay absent (never null/0/placeholder) so the domain layer
// and renderer can tell "unavailable" from "zero" honestly (plan normalized data contract).
//
// Timestamps are normalized to epoch milliseconds INSIDE the snapshot for calculation. ISO-string
// conversion happens once, at the persistence/API boundary (usage-snapshot-store.mjs), not here —
// this keeps the domain layer doing plain arithmetic instead of re-parsing dates on every render.

export const SCHEMA_VERSION = 1;

// Documented durations for the explicitly named Claude windows. Only applied to a window whose
// identity is certain; a generic or renamed rate-limit slot never gets an inferred duration.
const FIVE_HOUR_MINUTES = 300;
const WEEKLY_MINUTES = 10080;

// Codex windows are identified by duration, not primary/secondary position (plan Codex adapter).
const CODEX_WINDOW_BY_DURATION = { [FIVE_HOUR_MINUTES]: "fiveHour", [WEEKLY_MINUTES]: "weekly" };

function finitePercent(value) {
  if (value === null || value === undefined) return undefined;
  if (typeof value === "string" && value.trim() === "") return undefined;
  const number = Number(value);
  return Number.isFinite(number) ? number : undefined;
}

// Numeric resets_at values arrive as Unix epoch SECONDS (Claude status-line docs: "Unix epoch
// seconds when the ... window resets"; Codex RateLimitWindow follows the same convention) — only
// ISO strings are already millisecond-precise, so only those go through Date.parse directly.
function epochMs(value) {
  if (value === null || value === undefined || value === "") return undefined;
  const ms = typeof value === "number" ? value * 1000 : Date.parse(value);
  return Number.isFinite(ms) ? ms : undefined;
}

// Build a window object, omitting every field the source did not supply. A window is anchored by its
// used percentage: without one there is nothing to display or assess, so duration/reset alone never
// create a window (the named-window duration is only meaningful alongside a real used value).
function buildWindow({ usedPercent, durationMinutes, resetsAt }) {
  const used = finitePercent(usedPercent);
  if (used === undefined) return undefined;
  const window = { usedPercent: used };
  if (Number.isFinite(durationMinutes) && durationMinutes > 0) window.durationMinutes = durationMinutes;
  const reset = epochMs(resetsAt);
  if (reset !== undefined) window.resetsAt = reset;
  return window;
}

function assemble({ harness, now, context, windows, sourceKind }) {
  const snapshot = { schema: SCHEMA_VERSION, harness, collectedAt: now };
  if (context !== undefined) snapshot.context = { usedPercent: context };
  const present = Object.fromEntries(Object.entries(windows).filter(([, w]) => w !== undefined));
  if (Object.keys(present).length) snapshot.windows = present;
  snapshot.source = { kind: sourceKind, available: availablePaths(snapshot) };
  return snapshot;
}

// Diagnostics-only list of populated dotted paths — never includes credentials or raw payloads.
function availablePaths(snapshot) {
  const paths = [];
  if (snapshot.context?.usedPercent !== undefined) paths.push("context.usedPercent");
  for (const [name, window] of Object.entries(snapshot.windows || {})) {
    for (const field of Object.keys(window)) paths.push(`windows.${name}.${field}`);
  }
  return paths;
}

// Claude status-line JSON -> snapshot. Field map per plan Claude adapter table. Claude does not
// currently supply window durations, so the named five-hour / seven-day slots get their documented
// durations; a generic slot would not.
export function adaptClaudeStatusPayload(data, { now = Date.now() } = {}) {
  return assemble({
    harness: "claude",
    now,
    context: finitePercent(data?.context_window?.used_percentage),
    windows: {
      fiveHour: buildWindow({
        usedPercent: data?.rate_limits?.five_hour?.used_percentage,
        durationMinutes: FIVE_HOUR_MINUTES,
        resetsAt: data?.rate_limits?.five_hour?.resets_at,
      }),
      weekly: buildWindow({
        usedPercent: data?.rate_limits?.seven_day?.used_percentage,
        durationMinutes: WEEKLY_MINUTES,
        resetsAt: data?.rate_limits?.seven_day?.resets_at,
      }),
    },
    sourceKind: "claude-statusline",
  });
}

// Codex RateLimitSnapshot -> snapshot. Windows arrive as a list whose order is not reliable; select
// by window_duration_mins. used_percent is used directly (never parsed from a "##% left" string).
// contextUsedPercent is computed by the caller from Codex's token counts.
export function adaptCodexRateLimitSnapshot(snapshot, { now = Date.now(), contextUsedPercent } = {}) {
  const windows = { fiveHour: undefined, weekly: undefined };
  for (const raw of snapshot?.windows || []) {
    const name = CODEX_WINDOW_BY_DURATION[raw?.window_duration_mins];
    if (!name || windows[name]) continue; // unknown durations stay available to future consumers, not mislabeled
    windows[name] = buildWindow({
      usedPercent: raw.used_percent,
      durationMinutes: raw.window_duration_mins,
      resetsAt: raw.resets_at,
    });
  }
  return assemble({
    harness: "codex",
    now,
    context: finitePercent(contextUsedPercent),
    windows,
    sourceKind: "codex-app-server",
  });
}
