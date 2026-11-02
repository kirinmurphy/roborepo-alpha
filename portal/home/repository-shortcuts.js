import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { hrefWithRepositoryScope } from "/portal/shared/repository-scope.js";
import { notableTokenWarnings, tokenWarningsPanel } from "./domains.js";

// Plans, Agents, and Tokens sit as icon links beside the repo's ⋮ menu, each opening its page
// filtered to this repo. Plans and Tokens also carry a hover panel: Plans lists the lifecycle stages
// that hold plans (and is left out when none do), and Tokens (only while it has warnings worth raising) lists them. A repo with no
// urlKey (a demo card) has nothing to filter by, so it gets no shortcuts.
const PLAN_STAGES = ["ready", "active", "review", "backlog"];
const STAGE_LABELS = { review: "in review" };
// Long enough to cross the gap between an icon and its panel without the panel closing.
const HIDE_DELAY_MS = 150;

export function mountRepositoryShortcuts(host, repository) {
  if (!host || !repository.urlKey) return;
  const filtered = (path) => hrefWithRepositoryScope(path, repository.urlKey);
  // A repo with no plan in any stage has nothing for Plans to show, so its icon is left out.
  const planPanel = plansPanel(repository, filtered);
  const plans = planPanel && shortcut({ icon: "plans", label: "All Plans", href: filtered("/plans") });
  if (plans) attachHoverPanel(plans, planPanel);

  const agents = shortcut({ icon: "agents", label: "Agent Config", href: filtered("/agents") });

  const tokens = shortcut({ icon: "tokens", label: "Token Activity", href: filtered("/tokens") });
  const warnings = notableTokenWarnings(repository.domains.tokens.data);
  if (warnings.length) {
    tokens.classList.add("is-warning");
    const link = tokens.querySelector("a");
    link.setAttribute("aria-label", `Token Activity, ${warnings.length} warning${warnings.length === 1 ? "" : "s"}`);
    link.removeAttribute("title");
    const badge = document.createElement("portal-icon");
    badge.setAttribute("name", "warning");
    badge.setAttribute("size", "sm");
    badge.setAttribute("aria-hidden", "true");
    link.append(badge);
    attachHoverPanel(tokens, tokenWarningsPanel(warnings, filtered("/tokens")));
  }
  host.replaceChildren(...[plans, agents, tokens].filter(Boolean));
}

function shortcut({ icon, label, href }) {
  const node = tpl("tpl-repository-shortcut");
  const link = node.querySelector("a");
  link.href = href;
  link.setAttribute("aria-label", label);
  link.title = label;
  node.querySelector("[data-slot=icon]").setAttribute("name", icon);
  return node;
}

// "Plans", then one link per stage that holds plans, in the order work moves through them.
function plansPanel(repository, filtered) {
  const counts = repository.domains.plans.data?.counts;
  const stages = PLAN_STAGES.filter((stage) => counts?.[stage] > 0);
  if (!stages.length) return null;
  const panel = tpl("tpl-plans-shortcut-panel");
  const list = panel.querySelector("[data-slot=stages]");
  for (const stage of stages) {
    const item = fill(tpl("tpl-plans-shortcut-stage"), { count: String(counts[stage]), stage: STAGE_LABELS[stage] || stage });
    item.href = filtered(`/plans?lifecycle=${stage}`);
    list.append(item);
  }
  return panel;
}

// The icon stays a plain link; hovering or focusing it opens its panel, which holds links of its
// own, so it closes only after the pointer has left both. The card is raised while the panel shows
// so the panel overlaps the cards below it.
function attachHoverPanel(node, content) {
  node.querySelector(".repository-shortcut-link").removeAttribute("title");
  const panel = document.createElement("div");
  panel.className = "repository-shortcut-panel";
  panel.dataset.hoverPanel = "";
  panel.hidden = true;
  panel.append(content);
  node.append(panel);
  let timer = null;
  const show = () => {
    clearTimeout(timer);
    panel.hidden = false;
    node.closest(".repository-card")?.classList.add("has-open-menu");
  };
  const hide = () => {
    clearTimeout(timer);
    timer = setTimeout(() => {
      if (node.matches(":hover, :focus-within")) return;
      panel.hidden = true;
      node.closest(".repository-card")?.classList.remove("has-open-menu");
    }, HIDE_DELAY_MS);
  };
  node.addEventListener("mouseenter", show);
  node.addEventListener("mouseleave", hide);
  node.addEventListener("focusin", show);
  node.addEventListener("focusout", hide);
  node.addEventListener("keydown", (event) => {
    if (event.key !== "Escape") return;
    panel.hidden = true;
    node.closest(".repository-card")?.classList.remove("has-open-menu");
  });
}
