import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { hrefWithRepositoryScope } from "/portal/shared/repository-scope.js";

// Repository facts below the checkout and plan rows. Plans live in those rows now (plan-rows.js), so
// only Token Warnings remains here. Its link opens Tokens scoped to this repository, since the
// warnings it summarizes are this repository's.
export function appendRepositoryDomains(host, repository) {
  const tokens = repository.domains.tokens.data;
  if (tokens?.warningCount > 0) {
    const warnings = tokens.warnings || tokens.recent || [];
    host.append(domainRow("Recent Token Warnings", warningSummary(tokens.warningCount, warnings), {
      range: warningRange(warnings),
      glyph: "warning",
      warning: true,
      href: hrefWithRepositoryScope("/tokens", repository.urlKey),
      linkLabel: "all activity",
      details: [tokenWarnings(warnings)],
    }));
  }
  host.hidden = !host.childElementCount;
}

function domainRow(label, summary, { range = "", glyph, href, linkLabel, warning = false, details }) {
  // The heading reads "<label> <range> <link>"; the count rides along as the label's tooltip.
  const node = fill(tpl("tpl-domain-row"), { label, range });
  node.querySelector("[data-slot=label]").title = summary;
  node.querySelector("[data-slot=range]").hidden = !range;
  const icon = node.querySelector("[data-slot=glyph]");
  icon.setAttribute("name", glyph);
  node.classList.toggle("is-warning", warning);
  const link = node.querySelector("[data-slot=link]");
  link.href = href;
  link.textContent = linkLabel;
  const slot = node.querySelector("[data-slot=details]");
  slot.hidden = !details.length;
  slot.append(...details);
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
