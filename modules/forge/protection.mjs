// Branch protection status for one repository: reads what GitHub applies to the plans branch and
// the default branch, compares it with the managed policy, and creates or updates only the
// rulesets RoboRepo manages. Nothing here edits or deletes a ruleset RoboRepo did not create.
import { GitHubError, forgeClient, forgeTargetForRepositoryId } from "./index.mjs";
import {
  MANAGED_PREFIX, MERGE_POLICY_KEY, PLANS_BRANCH, PLANS_SAFE_RULE_TYPES,
  bypassNoWider, managedRulesets, ruleAtLeastAsStrict, rulesetBody, rulesetDrift, sameTarget,
} from "./protection-policy.mjs";

// States whose exit code is 0: the branches are protected, whoever owns the rulesets.
export const PROTECTED_STATES = new Set(["protected", "unmanaged"]);
// States a `roborepo protect` run can repair.
const REPAIRABLE_STATES = new Set(["unmanaged", "missing", "drifted"]);

// What GitHub answers when a repository's plan does not include rulesets (a private repository on
// a free plan). Rerunning cannot fix it, so it reads as `unsupported` rather than `unavailable`.
const RULESETS_REFUSED = { status: 403, message: /upgrade to github|make this repository public/i };

export const MANUAL_STEPS = [
  `On the ${PLANS_BRANCH} branch: block deletion, block force pushes, and require linear history. Add no other rule there (no required reviews, status checks, or signed commits), or plan saves will be refused.`,
  "On the default branch: block deletion and force pushes for everyone, admins included.",
  "On the default branch: require a pull request with 1 approval (including approval of the last push) and passing CI checks, with a bypass for repo admins only.",
];

// `target` is `{ repositoryId, cwd, timeoutMs }`. Always resolves to a report; a failure to read
// GitHub is a state (`unavailable` or `unsupported`), not an exception.
export async function readProtection(target) {
  const resolved = resolveTarget(target);
  if (resolved.report) return resolved.report;
  try {
    return assessProtection(await readSnapshot(resolved));
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return failureReport(resolved.repo, error);
  }
}

// Runs one action (`protect`, `skip`, or `unskip`) and reads the state again afterwards. The
// result carries the changes it made, or `refusal` saying why it made none. `onPlanned` receives
// the changes before the first write, so a caller can show them first.
export async function applyProtection(target, { action = "protect", onPlanned = () => {} } = {}) {
  const resolved = resolveTarget(target);
  const before = await readProtection(target);
  const planned = planChanges(before, action);
  if (planned.refusal || planned.changes.length === 0) return { before, changes: [], refusal: planned.refusal, report: before };
  onPlanned(planned.changes, before);
  const applied = [];
  let refusal = null;
  for (const change of planned.changes) {
    try {
      if (change.action === "create") await resolved.client.createRuleset(resolved.context, resolved.repo, change.body);
      else await resolved.client.updateRuleset(resolved.context, resolved.repo, change.rulesetId, change.body);
      applied.push(change);
    } catch (error) {
      if (!(error instanceof GitHubError)) throw error;
      refusal = `GitHub refused to ${change.action} ${change.name}: ${error.message}`;
      break;
    }
  }
  return { before, changes: applied, refusal, report: await readProtection(target) };
}

function resolveTarget({ repositoryId, cwd = process.cwd(), timeoutMs } = {}) {
  const parsed = forgeTargetForRepositoryId(repositoryId);
  if (!parsed) return { report: unsupportedReport(null, "this repo has no GitHub remote") };
  const client = forgeClient(parsed.host);
  if (!client.supported) return { report: unsupportedReport(parsed.repo, `${parsed.host} is not GitHub`) };
  return { client, repo: parsed.repo, context: { cwd, timeoutMs } };
}

async function readSnapshot({ client, context, repo }) {
  const [repository, login] = await Promise.all([client.repository(context, repo), client.login(context)]);
  const defaultBranch = repository.default_branch;
  const [plansRules, mainRules, listed, run] = await Promise.all([
    client.branchRules(context, repo, PLANS_BRANCH),
    client.branchRules(context, repo, defaultBranch),
    client.rulesets(context, repo),
    latestRunJobs(client, context, repo, defaultBranch),
  ]);
  // Only repository rulesets are read in full; one set by an organization is reported by name.
  const rulesets = await Promise.all(listed.map((entry) => (
    entry.source_type === "Repository" ? client.ruleset(context, repo, entry.id) : entry
  )));
  return {
    repo, defaultBranch, login, admin: repository.permissions?.admin === true,
    plansRules, mainRules, rulesets, requiredChecks: run?.jobs ?? [],
  };
}

// A repository with Actions off answers the runs endpoint with an HTTP error; that is the same
// as having no successful run to read job names from.
async function latestRunJobs(client, context, repo, branch) {
  try {
    return await client.latestSuccessfulRunJobs(context, repo, branch);
  } catch (error) {
    if (error instanceof GitHubError && error.kind === "http") return null;
    throw error;
  }
}

const isManaged = (ruleset) => ruleset.source_type === "Repository" && String(ruleset.name).startsWith(MANAGED_PREFIX);

// Maps what GitHub returned to a state and the detail behind it. Pure: every input is in
// `snapshot`, so the mapping is the same for the command, doctor, and the portal.
export function assessProtection(snapshot) {
  const { repo, defaultBranch, login, admin, plansRules, mainRules, rulesets, requiredChecks } = snapshot;
  const managed = new Map(rulesets.filter(isManaged).map((ruleset) => [ruleset.name, ruleset]));
  // GitHub returns bypass lists only to accounts that can manage the ruleset.
  const bypassVisible = rulesets.filter((ruleset) => ruleset.source_type === "Repository").every((ruleset) => Array.isArray(ruleset.bypass_actors));

  const policies = managedRulesets({ requiredChecks }).map((policy) => {
    const ruleset = managed.get(policy.name);
    const base = { key: policy.key, name: policy.name, branch: policy.branch === "plans" ? PLANS_BRANCH : defaultBranch, rulesetId: ruleset?.id ?? null };
    if (policy.key === MERGE_POLICY_KEY && ruleset?.enforcement === "disabled") {
      return { ...base, status: "skipped", missingRules: [], drift: [] };
    }
    if (ruleset) {
      const drift = rulesetDrift(ruleset, policy, { defaultBranch, bypassVisible });
      return { ...base, status: drift.length ? "drifted" : "ok", missingRules: [], drift };
    }
    // With no managed ruleset, a policy rule is missing unless some other ruleset applies it.
    const effective = policy.branch === "plans" ? plansRules : mainRules;
    const missingRules = policy.rules.filter((wanted) => !effective.some((rule) => ruleAtLeastAsStrict(rule, wanted))).map((rule) => rule.type);
    return { ...base, status: "absent", missingRules, drift: [] };
  });

  const names = new Map(rulesets.map((ruleset) => [ruleset.id, ruleset.name]));
  const conflicts = plansRules.filter((rule) => !PLANS_SAFE_RULE_TYPES.has(rule.type)).map((rule) => ({
    rule: rule.type, rulesetId: rule.ruleset_id ?? null, ruleset: names.get(rule.ruleset_id) || rule.ruleset_source || "an unnamed ruleset",
  }));

  const state = conflicts.length ? "conflicting"
    : policies.some((policy) => policy.missingRules.length) ? "missing"
      : policies.some((policy) => policy.status === "drifted") ? "drifted"
        : policies.some((policy) => policy.status === "absent") ? "unmanaged"
          : "protected";

  return {
    state, reason: null, repository: repo, defaultBranch, login, admin, bypassVisible,
    policies, conflicts,
    requiredChecks,
    handMade: handMadeRulesets(rulesets, { defaultBranch, bypassVisible }),
  };
}

// Each ruleset RoboRepo does not manage, and whether the active managed rulesets make it
// redundant: same branches, every one of its rules applied at least as strictly, and no one able
// to bypass the managed rule who could not bypass this one. Only then is deleting it safe.
function handMadeRulesets(rulesets, { defaultBranch, bypassVisible }) {
  const activeManaged = rulesets.filter((ruleset) => isManaged(ruleset) && ruleset.enforcement === "active");
  return rulesets.filter((ruleset) => !isManaged(ruleset)).map((ruleset) => {
    const base = { id: ruleset.id, name: ruleset.name };
    if (ruleset.source_type !== "Repository") return { ...base, source: "organization", covered: false, note: "set by the organization" };
    if (ruleset.enforcement !== "active") return { ...base, source: "repository", covered: false, note: `not enforced (${ruleset.enforcement})` };
    const peers = activeManaged.filter((peer) => sameTarget(ruleset, peer.conditions?.ref_name?.include, defaultBranch)
      && (!bypassVisible || bypassNoWider(peer.bypass_actors, ruleset.bypass_actors)));
    const uncovered = (ruleset.rules || []).filter((rule) => !peers.some((peer) => (peer.rules || []).some((managedRule) => ruleAtLeastAsStrict(managedRule, rule))));
    return uncovered.length === 0
      ? { ...base, source: "repository", covered: true, note: "covered by the managed rulesets; safe to delete" }
      : { ...base, source: "repository", covered: false, note: `still needed for: ${[...new Set(uncovered.map((rule) => rule.type))].join(", ")}` };
  });
}

// The writes one action needs, from a report alone. Only managed rulesets are ever named here.
export function planChanges(report, action) {
  if (!["protect", "skip", "unskip"].includes(action)) throw new Error(`Unknown protection action: ${JSON.stringify(action)}`);
  const none = (refusal) => ({ changes: [], refusal });
  if (["unsupported", "unavailable", "conflicting"].includes(report.state)) return none(`nothing was changed while the state is ${report.state}`);
  if (action === "protect" && !REPAIRABLE_STATES.has(report.state)) return none(null);
  if (!report.admin) return none(`${report.login} is not an admin of ${report.repository}; a repo admin must run roborepo protect`);

  const policyBodies = new Map(managedRulesets({ requiredChecks: report.requiredChecks }).map((policy) => [policy.key, policy]));
  const change = (policy, enforcement) => {
    const body = rulesetBody(policyBodies.get(policy.key), enforcement);
    return policy.rulesetId === null
      ? { action: "create", name: policy.name, enforcement, body }
      : { action: "update", name: policy.name, enforcement, rulesetId: policy.rulesetId, body };
  };
  if (action === "protect") {
    return { changes: report.policies.filter((policy) => ["absent", "drifted"].includes(policy.status)).map((policy) => change(policy, "active")), refusal: null };
  }
  const merge = report.policies.find((policy) => policy.key === MERGE_POLICY_KEY);
  if (action === "skip") return { changes: merge.status === "skipped" ? [] : [change(merge, "disabled")], refusal: null };
  return { changes: merge.status === "ok" ? [] : [change(merge, "active")], refusal: null };
}

function unsupportedReport(repo, reason) {
  return { ...emptyReport(repo), state: "unsupported", reason, manualSteps: MANUAL_STEPS };
}

function failureReport(repo, error) {
  if (error.kind === "http" && error.status === RULESETS_REFUSED.status && RULESETS_REFUSED.message.test(error.message)) {
    return unsupportedReport(repo, `GitHub does not offer rulesets for this repo: ${error.message}`);
  }
  const reason = error.kind === "http" ? `GitHub answered ${error.status}: ${error.message}` : error.message;
  return { ...emptyReport(repo), state: "unavailable", reason };
}

function emptyReport(repo) {
  return {
    state: null, reason: null, repository: repo, defaultBranch: null, login: null, admin: false, bypassVisible: false,
    policies: [], conflicts: [], requiredChecks: [], handMade: [],
  };
}
