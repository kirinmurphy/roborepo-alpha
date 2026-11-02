import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

// A single warning is noise, not a pattern, so a kind of warning is raised for a model only once it
// has happened this many times there. Each line the panel shows ("3 token spikes in gpt-5-codex")
// therefore counts at least this many.
const NOTABLE_WARNING_COUNT = 3;

// The warnings worth raising on Home: those whose kind has reached the threshold on their model.
export function notableTokenWarnings(tokens) {
  if (!(tokens?.warningCount > 0)) return [];
  const warnings = tokens.warnings || tokens.recent || [];
  const key = (warning) => `${warning.kind}\u0000${warning.model || ""}`;
  const counts = new Map();
  for (const warning of warnings) counts.set(key(warning), (counts.get(key(warning)) || 0) + 1);
  return warnings.filter((warning) => counts.get(key(warning)) >= NOTABLE_WARNING_COUNT);
}

// The Tokens shortcut's hover panel: "Recent Token Warnings <range> <all activity>", the count as the
// heading's tooltip, and one line per model. The link opens Tokens scoped to this repo, since the
// warnings it summarizes are this repo's.
export function tokenWarningsPanel(warnings, href) {
  const node = fill(tpl("tpl-token-warnings-panel"), { label: "Recent Token Warnings", range: warningRange(warnings) });
  node.querySelector("[data-slot=label]").title = warningSummary(warnings.length, warnings);
  node.querySelector("[data-slot=range]").hidden = !node.querySelector("[data-slot=range]").textContent;
  node.querySelector("[data-slot=link]").href = href;
  node.querySelector("[data-slot=details]").append(tokenWarnings(warnings));
  return node;
}

function warningSummary(count, warnings) {
  const label = `${count} warning${count === 1 ? "" : "s"}`;
  const days = warningDays(warnings);
  if (!days) return label;
  return days.first === days.last ? `${label} on ${days.first}` : `${label} from ${days.first} to ${days.last}`;
}

// "MM/DD - MM/DD" beside the heading, or one date when every warning fell on the same day.
function warningRange(warnings) {
  const days = warningDays(warnings);
  if (!days) return "";
  return days.first === days.last ? days.first : `${days.first} - ${days.last}`;
}

function warningDays(warnings) {
  const days = warnings.map((warning) => warning.at).filter(Boolean).sort();
  if (!days.length) return null;
  return { first: monthDay(days[0]), last: monthDay(days[days.length - 1]) };
}

function monthDay(iso) {
  return new Date(iso).toLocaleDateString(undefined, { month: "2-digit", day: "2-digit" });
}

const KIND_LABELS = {
  spike: ["token spike", "token spikes"],
  loop: ["repeated tool loop", "repeated tool loops"],
  "read-warning": ["repeated read warning", "repeated read warnings"],
};

// One line per model ("2 token spikes and 3 repeated tool loops in gpt-5-codex"), busiest model
// first. The per-session list lives on the Tokens page.
function tokenWarnings(warnings) {
  const byModel = new Map();
  for (const warning of warnings) {
    const model = warning.model || null;
    const kinds = byModel.get(model) || new Map();
    kinds.set(warning.kind, (kinds.get(warning.kind) || 0) + 1);
    byModel.set(model, kinds);
  }
  const rows = [...byModel].map(([model, kinds]) => ({ model, kinds, total: [...kinds.values()].reduce((sum, n) => sum + n, 0) }));
  rows.sort((a, b) => b.total - a.total);
  const list = tpl("tpl-token-warnings");
  for (const { model, kinds } of rows) {
    const parts = [...kinds].map(([kind, n]) => {
      const [one, many] = KIND_LABELS[kind] || [kind, kind];
      return `${n} ${n === 1 ? one : many}`;
    });
    const item = fill(tpl("tpl-token-warning"), { summary: joinList(parts), model: model || "an unknown model" });
    if (!model) item.querySelector("[data-slot=model]").classList.add("is-unknown");
    list.append(item);
  }
  return list;
}

function joinList(parts) {
  if (parts.length <= 1) return parts.join("");
  return `${parts.slice(0, -1).join(", ")} and ${parts[parts.length - 1]}`;
}
