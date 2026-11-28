// The shape of a branch protection report with nothing read into it. A provider's
// `branch-protection` capability starts from it for a state it could not assess, and
// modules/forge/protection.mjs uses it for a repo whose provider has no such capability, so every
// caller reads the same fields whichever produced the report.
// The one policy a repo may turn off (`roborepo protect --skip main-merge`): the default branch's
// merge rules. The plans and integrity rules have no opt-out on any host.
export const MERGE_POLICY_KEY = "main-merge";

export const UNSUPPORTED_PROTECTION_HEADLINE = "RoboRepo cannot manage protection for this repo.";

export function emptyProtectionReport({ repo, state, headline }) {
  return {
    state, headline, reason: null, repository: repo, defaultBranch: null, login: null, admin: false, bypassVisible: false, bypassVerified: false,
    policies: [], conflicts: [], requiredChecks: [], checksSource: "none", handMade: [],
  };
}
