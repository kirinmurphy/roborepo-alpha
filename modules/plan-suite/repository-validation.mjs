// The deterministic document findings for one plan, or every plan, in the repository containing
// `cwd`. This is the result `roborepo plans validate` prints; the model-driven checks a suite skill
// runs against code and docs are separate, and a clean result here is not evidence they ran.
import { repositoryOrderFindings } from "./backlog-registry.mjs";
import { buildRepositoryPlanSnapshot, selectRepositoryPlan } from "./index.mjs";

export function validateRepositoryPlans({ cwd = process.cwd(), selector = null } = {}) {
  const snapshot = buildRepositoryPlanSnapshot({ cwd });
  const selected = selector ? [selectRepositoryPlan(snapshot, selector, { cwd })] : snapshot.plans;
  const plans = selected.map((record) => ({
    id: record.plan.id,
    relativePath: record.plan.relativePath,
    lifecycle: record.plan.lifecycle,
    findings: record.plan.validation.findings,
  }));
  // The config and the ordering registry belong to no one plan.
  const repositoryFindings = repositoryOrderFindings(snapshot.root, snapshot.plans);
  const findings = [...plans.flatMap((plan) => plan.findings), ...repositoryFindings];
  return {
    repository: { name: snapshot.repository.name, repositoryId: snapshot.repository.repositoryId },
    plans,
    repositoryFindings,
    summary: {
      plans: plans.length,
      findings: findings.length,
      blocking: findings.filter((item) => item.severity === "blocking").length,
    },
  };
}
