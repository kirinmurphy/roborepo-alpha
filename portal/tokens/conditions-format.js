export const EVENT_NAMES = { spike: "spikes", loop: "loops", "read-warning": "read warnings" };
export const DIMENSION_NAMES = { model: "Models", repo: "Repos", harness: "Harnesses", packages: "Configured packages", skills: "Available skills" };
export const PROBLEM_KINDS = Object.keys(EVENT_NAMES);

export function percent(value) {
  return value == null ? "unavailable" : `${Math.round(value * 100)}%`;
}

export function repositoryLabel(value) {
  return value ? value.split("/").at(-1) : "Repo unknown";
}

export function conditionName(row) {
  return row.dimension === "repo" ? repositoryLabel(row.value) : row.value;
}

export function comparisonPresentation(row) {
  const event = EVENT_NAMES[row.event_kind] ?? row.event_kind;
  const raw = `${row.with_affected}/${row.with_condition} with · ${row.without_affected}/${row.without_condition} without`;
  if (!row.comparison_available) return { state: "unavailable", label: `Cannot compare ${event}`, detail: row.coverage === 0 ? "Condition data is missing." : "A known comparison group is missing.", raw };
  // A withheld percentage is insufficient evidence, never evidence of no difference.
  if (!row.percent_available || row.relative_delta == null) return {
    state: "thin", label: `${event}: ${raw}`, detail: "Too little evidence for a percentage comparison.", raw,
  };
  if (Math.abs(row.relative_delta) < (row.policy?.display_band ?? 0.2)) return { state: "neutral", label: `No clear difference in ${event}`, detail: "Rates fall within the display band.", raw };
  const state = row.relative_delta < 0 ? "fewer" : "more";
  return { state, label: `${percent(Math.abs(row.relative_delta))} ${state} ${event}`, detail: "Association only; tasks and other conditions may differ.", raw };
}

export function changePresentation(comparison) {
  const event = EVENT_NAMES[comparison.event_kind] ?? comparison.event_kind;
  const { before, after } = comparison;
  // Percentages appear only once the evidence supports a percentage comparison.
  const confident = comparison.relative_delta != null;
  const side = (cohort) => `${cohort.affected}/${cohort.observations} sessions${confident ? ` (${percent(cohort.rate)})` : ""}`;
  const counts = before && after ? `${side(before)} before → ${side(after)} after` : "";
  const unknown = comparison.unknown_condition ? ` · ${comparison.unknown_condition} unknown condition` : "";
  const exclusions = `${comparison.ambiguous_boundary ?? 0} ambiguous · ${comparison.spanning_boundary ?? 0} spanning${unknown}`;
  const detail = [counts, exclusions, "association only"].filter(Boolean).join(" · ");
  if (comparison.state !== "comparison available" || !before || !after) return {
    state: "collecting", label: `${event}: ${comparison.state ?? "unavailable"}`, detail,
    next: comparison.reason ?? (comparison.state === "collecting" ? "Keep collecting sessions on both sides of this change." : "A fair comparison needs a known scope and sessions on both sides."),
  };
  // Insufficient evidence is never reported as "no change", even when the raw rates match.
  if (!confident) {
    const direction = after.rate === before.rate ? "" : after.rate < before.rate ? "fewer " : "more ";
    return { state: "collecting", label: direction ? `Early signal: ${direction}${event}` : `${event}: too little evidence`, detail, next: "Collect more affected sessions before judging this change." };
  }
  if (Math.abs(comparison.relative_delta) < (comparison.policy?.display_band ?? 0.2)) return { state: "neutral", label: `No clear change in ${event}`, detail, next: "Rates fall within the display band; there is no clear improvement to act on yet." };
  const direction = comparison.relative_delta < 0 ? "fewer" : "more";
  return { state: direction, label: `${direction === "fewer" ? "Fewer" : "More"} ${event} after`, detail,
    next: direction === "fewer" ? "Keep monitoring; compare similar tasks before attributing improvement to this change." : "Inspect the affected sessions for regressions before changing the setup again." };
}

export function sessionKey(row) {
  return JSON.stringify([row.harness, row.session_id]);
}

export function problemLabel(row) {
  if (row.kind === "read-warning") return (row.warning_type ?? "Read warning").replaceAll("_", " ");
  return row.kind === "loop" ? `Loop · ${row.tool ?? "tool unknown"}` : "Spike";
}

export function problemAmount(row) {
  if (row.delta_tokens != null) return `+${row.delta_tokens.toLocaleString()} tokens`;
  if (row.wasted_tokens != null) return `${row.wasted_tokens.toLocaleString()} repeated tokens`;
  if (row.approx_tokens != null) return `about ${row.approx_tokens.toLocaleString()} tokens`;
  return row.max_repeat ? `×${row.max_repeat} in a row` : "";
}
