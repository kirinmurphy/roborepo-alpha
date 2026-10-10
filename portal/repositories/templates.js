import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";

export function unavailableView(message) {
  return fill(tpl("tpl-detail-message"), { message });
}

export function repositoryDetail(repository) {
  const node = fill(tpl("tpl-repository-detail"), {
    name: repository.displayName,
    meta: `${repository.kind === "git" ? "Git repository" : "Local repository"}${repository.providerUrl ? " · Remote available" : ""}`,
    lifecycle: repository.lifecycle.state,
  });
  node.querySelector("[data-slot=lifecycle]").dataset.state = repository.lifecycle.state;
  const provider = repository.providerUrl ? document.createElement("a") : "Local only";
  if (provider instanceof Node) {
    provider.href = repository.providerUrl;
    provider.target = "_blank";
    provider.rel = "noreferrer";
    provider.textContent = "Open remote ↗";
  }
  node.querySelector("[data-slot=identity]").append(
    fact("Browser key", repository.urlKey),
    fact("Provider", provider),
    fact("Known checkouts", repository.identity.localRoots.length),
    fact("Discovered by", repository.discoveredBy.join(", ") || "Unknown"),
  );
  node.querySelector("[data-slot=sections]").append(
    section("Workspace", repository.domains.runtime, "Checkouts and promoted running applications", workspaceBody(repository.domains.runtime)),
    section("Git", repository.domains.git, "Branch state and repository warnings", gitBody(repository.domains.git)),
    section("Plans", repository.domains.plans, "Coverage-aware active work and recent changes", plansBody(repository.domains.plans)),
    section("Tokens", repository.domains.tokens, "Recent repository-associated session warnings", tokensBody(repository.domains.tokens)),
    section("Agents", repository.domains.agents, "Repository-scoped configuration", messageBody(repository.domains.agents.message || "Unavailable")),
  );
  return node;
}

function fact(label, value) {
  return fill(tpl("tpl-detail-fact"), { label, value });
}

function section(title, envelope, subtitle, body) {
  const node = fill(tpl("tpl-detail-section"), { title, subtitle, status: envelope.status });
  node.querySelector("[data-slot=status]").dataset.status = envelope.status;
  node.querySelector("[data-slot=body]").append(body);
  return node;
}

function workspaceBody(envelope) {
  const checkouts = envelope.data?.checkouts || [];
  if (!checkouts.length) return messageBody(envelope.message || "No known checkouts.");
  const node = tpl("tpl-detail-checkouts");
  node.append(...checkouts.map(checkoutRow));
  return node;
}

function checkoutRow(checkout) {
  const node = fill(tpl("tpl-detail-checkout"), {
    name: checkout.name,
    kind: checkout.isWorktree ? "Worktree" : "Main checkout",
    git: gitLabel(checkout.git),
  });
  const slot = node.querySelector("[data-slot=entrypoint]");
  if (checkout.primaryEntrypoint) {
    const link = document.createElement("a");
    link.href = checkout.primaryEntrypoint.origin;
    link.target = "_blank";
    link.rel = "noreferrer";
    link.textContent = `:${checkout.primaryEntrypoint.port} ↗`;
    link.setAttribute("aria-label", `Open ${checkout.name} on port ${checkout.primaryEntrypoint.port}`);
    slot.replaceChildren(link);
  } else slot.textContent = "Not running";
  return node;
}

function gitBody(envelope) {
  if (!envelope.data) return messageBody(envelope.message || "Git data unavailable.");
  const warnings = envelope.data.warnings || [];
  if (!warnings.length) return messageBody("No Git warnings in the current cached snapshot.");
  return listBody(warnings.map((warning) => ({ title: warning, meta: "" })));
}

function plansBody(envelope) {
  if (!envelope.data) return messageBody(envelope.message || "Plan coverage unavailable.");
  const { counts, recent } = envelope.data;
  const rows = recent.map((plan) => ({ title: plan.title, meta: `${plan.lifecycle} · Recently changed ${formatDate(plan.changedAt)}` }));
  rows.unshift({ title: `${counts.active} active · ${counts.backlog} backlog`, meta: "Coverage" });
  return listBody(rows);
}

function tokensBody(envelope) {
  if (!envelope.data) return messageBody(envelope.message || "Token data unavailable.");
  const rows = (envelope.data.recent || []).map((finding) => ({ title: finding.kind, meta: `${finding.severity} · ${formatDate(finding.at)}` }));
  if (!rows.length) return messageBody(`${envelope.data.sessionCount} sessions · no repository-associated warnings`);
  return listBody(rows);
}

function listBody(rows) {
  const node = tpl("tpl-detail-list");
  node.append(...rows.map((row) => fill(tpl("tpl-detail-list-item"), row)));
  return node;
}

function messageBody(message) {
  return fill(tpl("tpl-detail-message"), { message });
}

function gitLabel(git) {
  if (!git) return "Git unavailable";
  const parts = [git.dirty === true ? "dirty" : git.dirty === false ? "clean" : "status unknown"];
  if (git.ahead) parts.push(`ahead ${git.ahead}`);
  if (git.behind) parts.push(`behind ${git.behind}`);
  if (git.baseBehind) parts.push(`${git.baseBehind} behind ${git.baseBranch}`);
  return parts.join(" · ");
}

function formatDate(value) {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "unknown" : date.toLocaleDateString();
}
