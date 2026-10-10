import { resolveRegistryAlias } from "../../modules/repositories/index.mjs";

const RECENT_PLAN_WINDOW_MS = 7 * 24 * 60 * 60 * 1000;

export function runtimeByRepository(snapshot, registry) {
  const repositories = new Map();
  for (const repository of snapshot?.repositories || []) {
    const repositoryId = repository.repositoryId && resolveRegistryAlias(registry, repository.repositoryId);
    if (registry.repositories?.[repositoryId]) repositories.set(repositoryId, projectWorkspace(repository));
  }
  return repositories;
}

// Coverage comes from the snapshot's per-repository scan state, so a repository Plans has not
// scanned (or could not read) gets no entry and Home reports "not scanned" instead of zero plans.
export function plansByRepository(snapshot, now, registry) {
  const coverage = new Map();
  for (const scan of snapshot?.repositoryScans || []) {
    if (scan.state !== "scanned") continue;
    const repositoryId = resolveRegistryAlias(registry, scan.repositoryId);
    if (registry.repositories?.[repositoryId]) coverage.set(repositoryId, { plans: [] });
  }
  for (const record of snapshot?.plans || []) {
    const sourceId = record.repository?.repositoryId;
    const repositoryId = sourceId && resolveRegistryAlias(registry, sourceId);
    if (!repositoryId || !registry.repositories?.[repositoryId]) continue;
    const group = coverage.get(repositoryId) || { plans: [] };
    group.plans.push({ ...record.plan, key: record.key });
    coverage.set(repositoryId, group);
  }
  const result = new Map();
  for (const [repositoryId, group] of coverage) result.set(repositoryId, planSummary(group.plans, now));
  return result;
}

export function telemetryByRepository(projection, registry) {
  const repositories = {};
  for (const [sourceId, source] of Object.entries(projection?.repositories || {})) {
    const repositoryId = resolveRegistryAlias(registry, sourceId);
    if (!registry.repositories?.[repositoryId]) continue;
    const summary = repositories[repositoryId] || (repositories[repositoryId] = {
      sessionCount: 0, warningCount: 0, highestSeverity: null, recent: [], warnings: [],
    });
    summary.sessionCount += source.sessionCount || 0;
    summary.warningCount += source.warningCount || 0;
    if (source.highestSeverity === "high" || !summary.highestSeverity) summary.highestSeverity = source.highestSeverity || null;
    summary.warnings.push(...(source.warnings || source.recent || []));
    summary.warnings.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    summary.recent.push(...(source.recent || []));
    summary.recent.sort((a, b) => String(b.at || "").localeCompare(String(a.at || "")));
    summary.recent = summary.recent.slice(0, 5);
  }
  return repositories;
}

export function unresolvedRuntimeActivity(runtimeState, registry) {
  if (!runtimeState.data) return [];
  return (runtimeState.data.repositories || [])
    .filter((repository) => {
      const repositoryId = repository.repositoryId && resolveRegistryAlias(registry, repository.repositoryId);
      return !repositoryId || !registry.repositories?.[repositoryId];
    })
    .map((repository) => ({ name: repository.name || "Unresolved activity", lifecycle: repository.lifecycle || { state: "active", reason: null } }));
}

export function planChangedAt(plan) {
  return plan?.gitLastChangedAt || plan?.modifiedAt || null;
}

function planSummary(plans, now) {
  const counts = { active: 0, backlog: 0 };
  for (const plan of plans) if (plan.lifecycle in counts) counts[plan.lifecycle] += 1;
  const recent = plans
    .map((plan) => ({ id: plan.id, title: plan.title, lifecycle: plan.lifecycle, changedAt: planChangedAt(plan) }))
    .filter((plan) => {
      const age = plan.changedAt ? now.getTime() - Date.parse(plan.changedAt) : Number.NaN;
      return Number.isFinite(age) && age >= 0 && age <= RECENT_PLAN_WINDOW_MS;
    })
    .sort((a, b) => Date.parse(b.changedAt) - Date.parse(a.changedAt))
    .slice(0, 5);
  const active = plans
    .filter((plan) => plan.lifecycle === "active")
    .map((plan) => ({ id: plan.id, key: plan.key, title: plan.title, lifecycle: plan.lifecycle, changedAt: planChangedAt(plan), worktree: plan.worktree || "", taskCounts: { total: plan.taskCounts?.total || 0, complete: plan.taskCounts?.complete || 0 } }))
    .sort((a, b) => Date.parse(b.changedAt || 0) - Date.parse(a.changedAt || 0) || a.title.localeCompare(b.title));
  return { counts, active, recent };
}

function projectWorkspace(repository) {
  return {
    lifecycle: repository.lifecycle || { state: "active", reason: null },
    lastSeenAt: repository.lastSeenAt || null,
    checkouts: (repository.roots || []).map((root) => ({
      rootId: root.rootId || null,
      name: root.git?.branch || (root.isWorktree ? "Worktree" : "Main checkout"),
      isWorktree: root.isWorktree === true,
      // Git's administrative worktree name; the key a plan's `worktree` frontmatter joins on. Main
      // checkouts never carry one, so they can never receive a plan.
      worktreeName: root.isWorktree === true ? root.git?.worktreeName || null : null,
      projectRoot: root.projectRoot || null,
      checkoutState: root.checkoutState || "present",
      checkoutReason: root.checkoutReason || null,
      git: root.git ? {
        branch: root.git.branch || null,
        detached: root.git.detached === true,
        shortHead: root.git.shortHead || null,
        dirty: root.git.dirty ?? null,
        ahead: root.git.ahead ?? null,
        behind: root.git.behind ?? null,
        upstream: root.git.upstream || null,
        baseBranch: root.git.baseBranch || null,
        baseBehind: root.git.baseBehind ?? null,
        baseMergeBaseAt: root.git.baseMergeBaseAt ?? null,
        upstreamTipAt: root.git.upstreamTipAt ?? null,
        fetchedAt: root.git.fetchedAt ?? null,
        provider: root.git.provider ? { ok: root.git.provider.ok !== false } : { ok: true },
      } : null,
      primaryEntrypoint: root.primaryEntrypoint ? {
        kind: root.primaryEntrypoint.kind,
        opaqueKey: root.primaryEntrypoint.opaqueKey || null,
        origin: root.primaryEntrypoint.origin,
        port: root.primaryEntrypoint.port,
        links: root.primaryEntrypoint.links || [],
      } : null,
    })),
  };
}
