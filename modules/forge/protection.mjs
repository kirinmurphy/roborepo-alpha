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
// result lists the changes that went through, and `refusal` says why the action stopped early or
// made none; a refusal partway keeps the earlier changes. `onPlanned` receives
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
  const [repository, login] = await settleAll([client.repository(context, repo), client.login(context)]);
  const defaultBranch = repository.default_branch;
  const [plansRules, mainRules, listed, run] = await settleAll([
    client.branchRules(context, repo, PLANS_BRANCH),
    client.branchRules(context, repo, defaultBranch),
    client.rulesets(context, repo),
    pullRequestCheckJobs(client, context, repo),
  ]);
  // Only repository rulesets are read in full; one set by an organization is reported by name.
  const rulesets = await settleAll(listed.map((entry) => (
    entry.source_type === "Repository" ? client.ruleset(context, repo, entry.id) : entry
  )));
  return {
    repo, defaultBranch, login, admin: repository.permissions?.admin === true,
    plansRules, mainRules, rulesets, foundChecks: run ? run.jobs : null,
  };
}

// Like Promise.all, but waits for every request before rejecting with the first failure. A read
// that gave up early would leave its sibling `gh` processes running after the report is returned.
async function settleAll(promises) {
  const results = await Promise.allSettled(promises);
  const failed = results.find((result) => result.status === "rejected");
  if (failed) throw failed.reason;
  return results.map((result) => result.value);
}

// A repository with Actions off answers the Actions endpoints with 404; that is the same as having
// no successful run to read job names from. Any other HTTP error (rate limit, 5xx) makes the whole
// read `unavailable`: reading it as "no run" would drop the required checks, and a `protect` run
// would then loosen the merge ruleset.
async function pullRequestCheckJobs(client, context, repo) {
  try {
    return await client.pullRequestCheckJobs(context, repo);
  } catch (error) {
    if (error instanceof GitHubError && error.kind === "http" && error.status === 404) return null;
    throw error;
  }
}

const isManaged = (ruleset) => ruleset.source_type === "Repository" && String(ruleset.name).startsWith(MANAGED_PREFIX);

// Maps what GitHub returned to a state and the detail behind it. Pure: every input is in
// `snapshot`, so the mapping is the same for the command, doctor, and the portal.
export function assessProtection(snapshot) {
  const { repo, defaultBranch, login, admin, plansRules, mainRules, rulesets, foundChecks } = snapshot;
  const managed = new Map(rulesets.filter(isManaged).map((ruleset) => [ruleset.name, ruleset]));
  const { requiredChecks, checksSource } = chooseRequiredChecks(foundChecks, managed);
  // GitHub returns bypass lists only to accounts that can manage the ruleset.
  const bypassVisible = rulesets.filter((ruleset) => ruleset.source_type === "Repository").every((ruleset) => Array.isArray(ruleset.bypass_actors));

  const policies = managedRulesets({ requiredChecks }).map((policy) => {
    const ruleset = managed.get(policy.name);
    const base = {
      key: policy.key, name: policy.name, branch: policy.branch === "plans" ? PLANS_BRANCH : defaultBranch,
      rulesetId: ruleset?.id ?? null, risk: policy.risk,
    };
    if (policy.key === MERGE_POLICY_KEY && ruleset?.enforcement === "disabled") {
      return describedPolicy({ ...base, status: "skipped", missingRules: [], drift: [] });
    }
    const effective = policy.branch === "plans" ? plansRules : mainRules;
    if (ruleset) {
      const drift = rulesetDrift(ruleset, policy, { defaultBranch, bypassVisible });
      // A managed ruleset that was disabled or lost a rule leaves that rule off its branch, which
      // is `missing` (shown to everyone), not only drift. A rule that still applies with other
      // parameters, such as a renamed CI check, is drift alone.
      const missingRules = policy.rules.filter((wanted) => !effective.some((rule) => rule.type === wanted.type)).map((rule) => rule.type);
      return describedPolicy({ ...base, status: drift.length ? "drifted" : "ok", missingRules, drift });
    }
    // With no managed ruleset, a policy rule is missing unless some other ruleset applies it.
    const missingRules = policy.rules.filter((wanted) => !effective.some((rule) => ruleAtLeastAsStrict(rule, wanted))).map((rule) => rule.type);
    return describedPolicy({ ...base, status: "absent", missingRules, drift: [] });
  });

  const names = new Map(rulesets.map((ruleset) => [ruleset.id, ruleset.name]));
  const conflicts = plansRules.filter((rule) => !PLANS_SAFE_RULE_TYPES.has(rule.type)).map((rule) => {
    const ruleset = names.get(rule.ruleset_id) || rule.ruleset_source || "an unnamed ruleset";
    return {
      rule: rule.type, rulesetId: rule.ruleset_id ?? null, ruleset,
      detail: `Rule ${rule.type} from ruleset ${ruleset} reaches the ${PLANS_BRANCH} branch and will refuse plan saves. Exclude that branch from the ruleset.`,
    };
  });

  const state = conflicts.length ? "conflicting"
    : policies.some((policy) => policy.missingRules.length) ? "missing"
      : policies.some((policy) => policy.status === "drifted") ? "drifted"
        : policies.some((policy) => policy.status === "absent") ? "unmanaged"
          : "protected";

  return {
    state, headline: STATE_HEADLINES[state], reason: null, repository: repo, defaultBranch, login, admin, bypassVisible,
    policies, conflicts,
    requiredChecks, checksSource,
    handMade: handMadeRulesets(rulesets, { defaultBranch, bypassVisible }),
  };
}

// The checks the merge policy requires. With no successful pull-request run to read them from
// (runs aged out, or Actions off), an existing managed merge ruleset keeps the checks it already
// requires, so a quiet repo never loses its CI gate on the next `protect`. `checksSource` says which:
// `pull-requests`, `kept`, or `none`.
function chooseRequiredChecks(foundChecks, managed) {
  if (foundChecks) return { requiredChecks: foundChecks, checksSource: "pull-requests" };
  const merge = managed.get(`${MANAGED_PREFIX}main-merge`);
  const statusRule = (merge?.rules || []).find((rule) => rule.type === "required_status_checks");
  const kept = (statusRule?.parameters?.required_status_checks || []).map((check) => check.context);
  return kept.length > 0 ? { requiredChecks: kept, checksSource: "kept" } : { requiredChecks: [], checksSource: "none" };
}

// One sentence per state, shared by the command and the portal panel.
const STATE_HEADLINES = {
  protected: "Both branches match the RoboRepo policy.",
  unmanaged: "Both branches are protected, but by hand-made rulesets rather than RoboRepo's.",
  missing: "Part of the policy does not apply yet.",
  drifted: "A RoboRepo ruleset no longer matches the policy.",
  conflicting: "A rule on the plans branch will refuse plan saves.",
  unavailable: "GitHub could not be read.",
  unsupported: "RoboRepo cannot manage protection for this repo.",
};

function describedPolicy(policy) {
  const detail = policy.status === "skipped" ? "skipped (turned off for this repo)"
    : policy.status === "ok" ? "matches the policy"
      : policy.status === "drifted" ? `differs from the policy: ${policy.drift.join("; ")}`
        : policy.missingRules.length > 0 ? `not created; missing ${policy.missingRules.join(", ")}`
          : "not created; hand-made rulesets apply its rules";
  return { ...policy, detail };
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
  if (!report.admin) return none(`signed in to GitHub as ${report.login}, who is not an admin of ${report.repository}; a repo admin must run roborepo protect`);

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
  return { ...emptyReport(repo, "unsupported"), reason, manualSteps: MANUAL_STEPS };
}

function failureReport(repo, error) {
  if (error.kind === "http" && error.status === RULESETS_REFUSED.status && RULESETS_REFUSED.message.test(error.message)) {
    return unsupportedReport(repo, `GitHub does not offer rulesets for this repo: ${error.message}`);
  }
  const reason = error.kind === "http" ? `GitHub answered ${error.status}: ${error.message}` : error.message;
  return { ...emptyReport(repo, "unavailable"), reason };
}

function emptyReport(repo, state) {
  return {
    state, headline: STATE_HEADLINES[state], reason: null, repository: repo, defaultBranch: null, login: null, admin: false, bypassVisible: false,
    policies: [], conflicts: [], requiredChecks: [], checksSource: "none", handMade: [],
  };
}
