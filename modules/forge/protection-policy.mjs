// The branch protection RoboRepo manages on GitHub, as data: three rulesets, split because a
// ruleset's bypass list applies to every rule in it. The admin bypass on the merge ruleset must
// not reach the integrity rules, or an admin token could force-push the default branch.
import { isDeepStrictEqual } from "node:util";

export const MANAGED_PREFIX = "roborepo-";
export const PLANS_BRANCH = "repo-plans";
export const DEFAULT_BRANCH_REF = "~DEFAULT_BRANCH";
export const MERGE_POLICY_KEY = "main-merge";

// GitHub's built-in repository role ids: 5 is admin (4 is write, 2 is maintain).
const REPO_ADMIN_BYPASS = { actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" };

// The plans store pushes unsigned commits straight to its branch, fast-forward only. These three
// rule types never refuse such a push. Any other type is treated as able to refuse one, because a
// type GitHub adds later cannot be shown safe from here.
export const PLANS_SAFE_RULE_TYPES = new Set(["deletion", "non_fast_forward", "required_linear_history"]);

// `requiredChecks` is the list of CI job names to require, or empty when the default branch has
// no successful run to read them from; the status-check rule is then left out.
export function managedRulesets({ requiredChecks = [] } = {}) {
  const mergeRules = [{
    type: "pull_request",
    parameters: {
      required_approving_review_count: 1,
      require_last_push_approval: true,
      dismiss_stale_reviews_on_push: false,
      require_code_owner_review: false,
      required_review_thread_resolution: false,
    },
  }];
  if (requiredChecks.length > 0) {
    mergeRules.push({
      type: "required_status_checks",
      parameters: {
        // "Up to date" off: a pull request need not be rebased onto the newest default branch.
        strict_required_status_checks_policy: false,
        required_status_checks: requiredChecks.map((context) => ({ context })),
      },
    });
  }
  // `risk` is the clause the Plans notice lists after "is not fully protected on GitHub:".
  return [
    {
      key: "plans",
      name: `${MANAGED_PREFIX}plans`,
      branch: "plans",
      include: [`refs/heads/${PLANS_BRANCH}`],
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }],
      bypass_actors: [],
      risk: "plan history can be deleted or rewritten",
    },
    {
      key: "main-integrity",
      name: `${MANAGED_PREFIX}main-integrity`,
      branch: "default",
      include: [DEFAULT_BRANCH_REF],
      rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
      bypass_actors: [],
      risk: "the default branch can be deleted or force-pushed",
    },
    {
      key: MERGE_POLICY_KEY,
      name: `${MANAGED_PREFIX}main-merge`,
      branch: "default",
      include: [DEFAULT_BRANCH_REF],
      rules: mergeRules,
      bypass_actors: [REPO_ADMIN_BYPASS],
      risk: "changes can reach the default branch without review or passing CI",
    },
  ];
}

// The body GitHub's create and update ruleset endpoints take.
export function rulesetBody(policy, enforcement = "active") {
  return {
    name: policy.name,
    target: "branch",
    enforcement,
    bypass_actors: policy.bypass_actors,
    conditions: { ref_name: { include: policy.include, exclude: [] } },
    rules: policy.rules,
  };
}

const ALL_MERGE_METHODS = ["merge", "rebase", "squash"];

const requiredChecks = (parameters) => parameters?.required_status_checks || [];
const checkContexts = (parameters) => requiredChecks(parameters).map((check) => check.context);
// False, null, and an empty list ask for nothing.
const asksForNothing = (value) => value === undefined || value === null || value === false || (Array.isArray(value) && value.length === 0);

// Whether `actual` is at least as strict as `wanted`, for two rules of one type. A parameter
// `wanted` leaves out asks for nothing, so GitHub's defaults on `actual` never count against it.
export function ruleAtLeastAsStrict(actual, wanted) {
  if (actual.type !== wanted.type) return false;
  const have = actual.parameters || {};
  const want = wanted.parameters || {};
  if (wanted.type === "pull_request") {
    const methods = (parameters) => parameters.allowed_merge_methods || ALL_MERGE_METHODS;
    const { required_approving_review_count: wantedCount = 0, allowed_merge_methods: _wantedMethods, ...requirements } = want;
    return (have.required_approving_review_count || 0) >= wantedCount
      && methods(have).every((method) => methods(want).includes(method))
      // Every other setting is a requirement that is either off or has to be matched exactly.
      && Object.entries(requirements).every(([key, value]) => asksForNothing(value) || isDeepStrictEqual(have[key], value));
  }
  if (wanted.type === "required_status_checks") {
    // A check tied to one app is stricter than the same check from any source.
    const supplied = (check) => requiredChecks(have).some((candidate) => candidate.context === check.context
      && (check.integration_id == null || candidate.integration_id === check.integration_id));
    return requiredChecks(want).every(supplied)
      && (!want.strict_required_status_checks_policy || have.strict_required_status_checks_policy === true)
      && (!have.do_not_enforce_on_create || want.do_not_enforce_on_create === true);
  }
  // Types with no comparison of their own match only when their parameters are identical.
  return isDeepStrictEqual(have, want);
}

// How a managed ruleset on GitHub differs from its policy, as phrases a person can act on; empty
// when it matches. `bypassVisible` is false for an account GitHub does not show bypass lists to.
export function rulesetDrift(ruleset, policy, { defaultBranch, bypassVisible }) {
  const drift = [];
  if (ruleset.enforcement !== "active") drift.push(`enforcement is ${ruleset.enforcement}`);
  if (!sameTarget(ruleset, policy.include, defaultBranch)) drift.push("it targets different branches");
  const actualTypes = (ruleset.rules || []).map((rule) => rule.type);
  for (const wanted of policy.rules) {
    const actual = (ruleset.rules || []).find((rule) => rule.type === wanted.type);
    if (!actual) drift.push(`rule ${wanted.type} is missing`);
    else if (!policyParametersMatch(actual, wanted)) drift.push(describeRuleDrift(actual, wanted));
  }
  for (const type of actualTypes) {
    if (!policy.rules.some((rule) => rule.type === type)) drift.push(`rule ${type} is not part of the policy`);
  }
  if (bypassVisible && !sameBypass(ruleset.bypass_actors || [], policy.bypass_actors)) drift.push("its bypass list differs");
  return drift;
}

// Exact match on every parameter the policy sets. Required checks compare as a set of names.
function policyParametersMatch(actual, wanted) {
  const have = actual.parameters || {};
  return Object.entries(wanted.parameters || {}).every(([key, value]) => {
    if (key === "required_status_checks") return isDeepStrictEqual(checkContexts(have).sort(), checkContexts(wanted.parameters).sort());
    return isDeepStrictEqual(have[key], value);
  });
}

function describeRuleDrift(actual, wanted) {
  if (wanted.type !== "required_status_checks") return `rule ${wanted.type} has different settings`;
  const have = new Set(checkContexts(actual.parameters));
  const want = new Set(checkContexts(wanted.parameters));
  const added = [...want].filter((context) => !have.has(context));
  const removed = [...have].filter((context) => !want.has(context));
  const parts = [];
  if (added.length) parts.push(`not required yet: ${added.join(", ")}`);
  if (removed.length) parts.push(`no longer a CI job: ${removed.join(", ")}`);
  return parts.length ? `required checks differ (${parts.join("; ")})` : "rule required_status_checks has different settings";
}

// A ruleset's branch conditions, with the default-branch token resolved so `~DEFAULT_BRANCH` and
// `refs/heads/<default>` compare equal.
function refSet(patterns, defaultBranch) {
  return [...new Set((patterns || []).map((pattern) => (pattern === DEFAULT_BRANCH_REF ? `refs/heads/${defaultBranch}` : pattern)))].sort();
}

export function sameTarget(ruleset, include, defaultBranch) {
  const conditions = ruleset.conditions?.ref_name || {};
  return ruleset.target === "branch"
    && isDeepStrictEqual(refSet(conditions.include, defaultBranch), refSet(include, defaultBranch))
    && refSet(conditions.exclude, defaultBranch).length === 0;
}

const bypassKey = (actor) => `${actor.actor_type}:${actor.actor_id ?? ""}:${actor.bypass_mode || "always"}`;

function sameBypass(actual, wanted) {
  return isDeepStrictEqual(actual.map(bypassKey).sort(), wanted.map(bypassKey).sort());
}

// Whether every actor that can bypass `inner` can bypass `outer` in the same mode.
export function bypassNoWider(inner, outer) {
  const allowed = new Set((outer || []).map(bypassKey));
  return (inner || []).every((actor) => allowed.has(bypassKey(actor)));
}
