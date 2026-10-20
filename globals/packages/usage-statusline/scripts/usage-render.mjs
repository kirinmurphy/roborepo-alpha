// Presentation: turn an assessed snapshot (usage-domain.mjs) into the one-line status string.
// Builds fragment lists first — {text, tone} — so debt and total-used values inside one weekly
// segment can carry different colors (plan "independent styling"). ANSI is applied only at the
// final join, and only in color mode; NO_COLOR yields byte-identical text minus escapes.

export const ANSI = {
  normalPercent: "[0m", // explicit bright white — normal percentages are never left muted
  caution: "[38;5;220m", // yellow
  warning: "[38;5;208m", // orange
  critical: "[91m", // bright red
  reset: "[0m",
};

// Tones that receive an ANSI color. label/unavailable stay terminal-default (no escape).
const TONED = new Set(["normalPercent", "caution", "warning", "critical"]);

const SEVERITY_TONE = {
  normal: "normalPercent",
  caution: "caution",
  warning: "warning",
  critical: "critical",
};

function severityTone(severity) {
  return SEVERITY_TONE[severity] || "label";
}

function usedFragment(usedPercent, usedSeverity) {
  return { text: `${usedPercent}%`, tone: severityTone(usedSeverity) };
}

// Weekly fragments. With elapsed known we emit used percent plus compact pacing
// (debt/surplus/balanced). Without elapsed we fall back to the compact used-only form.
// Neither available -> em dash.
function weeklyFragments(weekly) {
  if (!weekly.available) return [{ text: "Weekly: —", tone: "unavailable" }];
  if (weekly.elapsedPercent === undefined) {
    return [
      { text: "Weekly: ", tone: "label" },
      usedFragment(weekly.usedPercent, weekly.usedSeverity),
    ];
  }
  const { balance, usedPercent, elapsedPercent, usedSeverity } = weekly;
  const lead =
    balance.state === "balanced"
      ? { text: "balanced", tone: "normalPercent" }
      : {
          text: `${balance.magnitude}% ${balance.state}`,
          tone: severityTone(balance.debtSeverity),
        };
  return [
    { text: "Weekly: ", tone: "label" },
    usedFragment(usedPercent, usedSeverity),
    { text: " (", tone: "label" },
    lead,
    { text: ")", tone: "label" },
    // { text: " / ", tone: "label" },
    // { text: `${elapsedPercent}% elapsed`, tone: "normalPercent" },
  ];
}

// Five-hour and context keep the compact used-only display (five-hour pacing is intentionally not shown).
function usedOnlyFragments(label, assessed) {
  if (!assessed.available)
    return [{ text: `${label}: —`, tone: "unavailable" }];
  return [
    { text: `${label}: `, tone: "label" },
    usedFragment(assessed.usedPercent, assessed.usedSeverity),
  ];
}

function renderFragment(fragment, color) {
  if (!color || !TONED.has(fragment.tone)) return fragment.text;
  return `${ANSI[fragment.tone]}${fragment.text}${ANSI.reset}`;
}

function joinSegments(segments, color) {
  return segments
    .map((fragments) =>
      fragments.map((fragment) => renderFragment(fragment, color)).join(""),
    )
    .join(" · ");
}

export function renderStatusLine(
  assessed,
  { color = !Object.hasOwn(process.env, "NO_COLOR") } = {},
) {
  const segments = [
    usedOnlyFragments("Context", assessed.context),
    usedOnlyFragments("5h", assessed.windows.fiveHour),
    weeklyFragments(assessed.windows.weekly),
  ];
  return joinSegments(segments, color);
}
