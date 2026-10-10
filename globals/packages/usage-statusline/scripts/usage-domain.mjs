// Pure usage assessment: clamp, elapsed, balance, and severity rules. No I/O, no ANSI, no harness
// shapes — inputs are the normalized snapshot (see usage-adapters.mjs), outputs are semantic tones
// consumed by usage-render.mjs and the portal API. The same thresholds must be mirrored by the
// Codex Rust footer (see fixtures/usage-cases.json) so both implementations agree.

export const BALANCE_TOLERANCE = 5; // |used - elapsed| < 5 points is Balanced (5 itself is not)

// Context-used severity. Three tiers, inclusive lower bounds: below 30 is normal; 30-49 is caution;
// 50-59 is warning; 60+ is critical. Each threshold is the first percent that belongs to its tier
// (e.g. 30 itself is caution, not normal). Kept as one object so each boundary is one place to edit.
export const USAGE_SEVERITY = { cautionAtLeast: 30, warningAtLeast: 50, criticalAtLeast: 60 };

// Rate-limit window severity keeps the older thresholds: 70 stays normal, 71 crosses to warning;
// 85 stays warning, 86 crosses to critical. Context has the more aggressive caution/warning tiers.
export const RATE_LIMIT_SEVERITY = { warningAbove: 70, criticalAbove: 85 };

// Debt (used ahead of elapsed) severity. 5-19 points warning, >=20 critical.
export const DEBT_SEVERITY = { warningAtLeast: 5, criticalAtLeast: 20 };

export function clampPercent(value) {
  return Math.min(100, Math.max(0, value));
}

// Whole-percent value for display AND classification. Display-rounded inputs drive
// the UI assessment, so the visible arithmetic
// (85 used - 70 elapsed = 15 debt) always matches the label. Returns null for anything not finite.
export function roundPercent(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const number = Number(value);
  return Number.isFinite(number) ? Math.round(clampPercent(number)) : null;
}

// Elapsed fraction of a rolling window, from its reset time and duration. Returns null unless all
// inputs are valid — never guesses. now/resetsAt are epoch ms; durationMinutes is positive minutes.
export function elapsedPercent({ resetsAt, durationMinutes, now }) {
  if (!Number.isFinite(resetsAt) || !Number.isFinite(now)) return null;
  if (!Number.isFinite(durationMinutes) || durationMinutes <= 0) return null;
  const durationMs = durationMinutes * 60 * 1000;
  const remaining = resetsAt - now;
  return clampPercent(100 * (1 - remaining / durationMs));
}

export function usageSeverity(usedPercent) {
  if (!Number.isFinite(usedPercent)) return "unavailable";
  if (usedPercent >= USAGE_SEVERITY.criticalAtLeast) return "critical";
  if (usedPercent >= USAGE_SEVERITY.warningAtLeast) return "warning";
  if (usedPercent >= USAGE_SEVERITY.cautionAtLeast) return "caution";
  return "normal";
}

export function rateLimitSeverity(usedPercent) {
  if (!Number.isFinite(usedPercent)) return "unavailable";
  if (usedPercent > RATE_LIMIT_SEVERITY.criticalAbove) return "critical";
  if (usedPercent > RATE_LIMIT_SEVERITY.warningAbove) return "warning";
  return "normal";
}

function debtSeverity(magnitude) {
  if (magnitude >= DEBT_SEVERITY.criticalAtLeast) return "critical";
  if (magnitude >= DEBT_SEVERITY.warningAtLeast) return "warning";
  return "normal";
}

// Classify used-vs-elapsed pacing. Difference is kept for callers that want the sign; magnitude is
// the absolute gap. Surplus severity is always normal regardless of size — only debt escalates.
export function assessBalance({ usedPercent, elapsedPercent: elapsed }) {
  if (!Number.isFinite(usedPercent) || !Number.isFinite(elapsed)) {
    return { state: "unavailable" };
  }
  const difference = usedPercent - elapsed;
  const magnitude = Math.abs(difference);
  if (magnitude < BALANCE_TOLERANCE) return { state: "balanced", difference, magnitude };
  if (difference > 0) return { state: "debt", difference, magnitude, debtSeverity: debtSeverity(magnitude) };
  return { state: "surplus", difference, magnitude, debtSeverity: "normal" };
}

// Assess one rolling window: total-used severity and (when elapsed is known) pacing. Both are
// returned independently — a window may carry a warning-orange used value and a normal-white
// elapsed value at once (plan "independent styling"). Rounds inputs first so the assessment matches
// what the renderer will print.
export function assessWindow(window, { now } = {}) {
  const usedPercent = roundPercent(window?.usedPercent);
  if (usedPercent === null) return { available: false };
  const elapsedRaw = elapsedPercent({
    resetsAt: window.resetsAt,
    durationMinutes: window.durationMinutes,
    now,
  });
  const elapsed = roundPercent(elapsedRaw);
  const usedSeverity = rateLimitSeverity(usedPercent);
  if (elapsed === null) {
    return { available: true, usedPercent, usedSeverity };
  }
  const balance = assessBalance({ usedPercent, elapsedPercent: elapsed });
  return { available: true, usedPercent, elapsedPercent: elapsed, usedSeverity, balance };
}

// Whole-snapshot assessment consumed by both the status line and the portal API. Context has no
// window, so it only carries a used severity.
export function assessUsage(snapshot, { now = Date.now() } = {}) {
  const contextUsed = roundPercent(snapshot?.context?.usedPercent);
  return {
    harness: snapshot?.harness,
    collectedAt: snapshot?.collectedAt,
    context:
      contextUsed === null
        ? { available: false }
        : { available: true, usedPercent: contextUsed, usedSeverity: usageSeverity(contextUsed) },
    windows: {
      fiveHour: assessWindow(snapshot?.windows?.fiveHour, { now }),
      weekly: assessWindow(snapshot?.windows?.weekly, { now }),
    },
  };
}
