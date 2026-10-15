import { conditionTemplate, setText } from "./conditions-dom.js";
import { repositoryLabel, PROBLEM_KINDS, problemLabel, problemAmount } from "./conditions-format.js";

export function compactContext(context) {
  const line = document.createElement("div");
  line.className = "condition-context";
  appendChip(line, context.model ?? "Model unknown", "Model", !context.model);
  appendChip(line, context.harness ?? "Harness unknown", "Harness", !context.harness);
  const resources = resourceConditions(context);
  const present = resources.filter((condition) => condition.state === "present");
  const missing = resources.length === 0 || resources.some((condition) => condition.state === "unknown");
  const label = present.length ? `${present.length} resources${missing ? " · partial" : ""}` : missing ? "Config unknown" : "No resources";
  appendChip(line, label, conditionResourceSummary(context), missing);
  return line;
}

export function sessionConditionLine(data, sessionId, harness, options = {}) {
  const row = data?.conditions?.ledger.find((item) => item.session_id === sessionId && (!harness || item.harness === harness) && item.context?.conditions.length);
  if (!row) return null;
  const context = row.context;
  if (!options.includeFacts) return compactContext(context);
  const block = conditionTemplate("condition-session-context-template");
  const facts = block.querySelector("[data-facts]");
  const addFact = (label, value) => {
    const fact = conditionTemplate("condition-session-fact-template");
    setText(fact, "dt", label);
    setText(fact, "dd", value);
    facts.appendChild(fact);
  };
  const session = data.sessions?.find((item) => item.session_id === sessionId && (!harness || item.harness === harness));
  addFact("Next step", options.findings?.find((item) => item.hint)?.hint ?? row.detail ?? "Inspect the transcript and supporting evidence.");
  addFact("Repo / harness", `${session?.repo ?? repositoryLabel(context.repository_id)} · ${context.harness ?? "unknown"}`);
  addFact("Model attribution", context.model ? `${context.model} · ${context.model_attribution}` : "Model unknown");
  addFact("Configuration", conditionResourceSummary(context));
  addFact("Observation unit", "One affected session counts once in each problem rate.");
  addFact("Coverage", ["model", "repo", "harness", "packages", "skills"].map((dimension) => {
    const entries = context.conditions.filter((condition) => condition.dimension === dimension);
    return `${dimension} ${entries.length && entries.every((condition) => condition.evaluable) ? "known" : "unknown"}`;
  }).join(" · "));
  return block;
}

export function conditionResourceSummary(context) {
  const resources = resourceConditions(context);
  const present = resources.filter((condition) => condition.state === "present");
  const unknown = resources.length === 0 || resources.some((condition) => condition.state === "unknown");
  const names = present.map((condition) => `${condition.value} ${condition.dimension === "skills" ? "available" : "configured"}`);
  if (unknown) names.push("some configuration unknown");
  return names.join(", ") || "No resources present among evaluated conditions";
}

function resourceConditions(context) {
  return (context.conditions ?? []).filter((condition) => ["packages", "skills"].includes(condition.dimension));
}

function appendChip(line, value, label, unknown) {
  const chip = conditionTemplate("condition-chip-template");
  chip.textContent = value;
  chip.title = `${label}${["Model", "Harness"].includes(label) ? `: ${value}` : ""}`;
  chip.setAttribute("aria-label", chip.title);
  chip.classList.toggle("unknown", unknown);
  line.appendChild(chip);
}


export function capturedSessionFindings(data, sessionId, harness) {
  return (data?.conditions?.ledger ?? [])
    .filter((row) => row.session_id === sessionId && (!harness || row.harness === harness) && PROBLEM_KINDS.includes(row.kind))
    .map((row) => ({ summary: [problemLabel(row), problemAmount(row)].filter(Boolean).join(" · "), hint: row.detail, severity: row.kind === "loop" ? "high" : "warn" }));
}
