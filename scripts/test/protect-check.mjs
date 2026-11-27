#!/usr/bin/env node
// `roborepo protect` against a fake `gh`: every state's output and exit code, exactly which
// rulesets a run creates or updates, and that no run ever touches a ruleset it does not manage.

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { RULESETS_REFUSED_MESSAGE, createFakeGh, fakeGitHubState } from "./lib/fake-gh.mjs";
import { isolateGitConfig } from "./lib/git-config.mjs";

if (process.platform === "win32") {
  console.log("skip: the fake gh executable requires a POSIX executable fixture");
  process.exit(0);
}

// modules/forge/ is the one home for `gh`: nothing else in shipped code may start it.
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const startsGh = /\b(?:execFile|execFileSync|execFileAsync|spawn|spawnSync)\(\s*["'`]gh["'`]/;
const ghCallers = ["modules", "scripts/cli", "scripts/harnesses", "scripts/build", "scripts/lib", "scripts/install", "globals"]
  .flatMap((dir) => fs.readdirSync(path.join(repoRoot, dir), { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile() && /\.(?:mjs|js|cjs)$/.test(entry.name))
    .map((entry) => path.relative(repoRoot, path.join(entry.parentPath, entry.name))))
  .filter((file) => startsGh.test(fs.readFileSync(path.join(repoRoot, file), "utf8")));
assert.deepEqual(ghCallers.map((file) => file.split(path.sep).join("/")), ["modules/forge/github.mjs"]);
console.log("✓ Only modules/forge/ starts the GitHub CLI.");

const cli = fileURLToPath(new URL("../cli/main.mjs", import.meta.url));
const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-protect-"));
isolateGitConfig(root);

const ADMIN_BYPASS = [{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "always" }];
const MAIN = { ref_name: { include: ["~DEFAULT_BRANCH"], exclude: [] } };
const PLANS = { ref_name: { include: ["refs/heads/repo-plans"], exclude: [] } };
const CHECKS = ["check (macos-latest)", "check (ubuntu-latest)"];
const pullRequest = (overrides = {}) => ({
  type: "pull_request",
  parameters: {
    required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews_on_push: false,
    require_code_owner_review: false, required_review_thread_resolution: false,
    allowed_merge_methods: ["merge", "squash", "rebase"], ...overrides,
  },
});
const statusChecks = (contexts) => ({
  type: "required_status_checks",
  parameters: { strict_required_status_checks_policy: false, required_status_checks: contexts.map((context) => ({ context })) },
});
const handMade = (id, name, conditions, rules, extra = {}) => ({
  id, name, target: "branch", source_type: "Repository", source: "example/project", enforcement: "active",
  bypass_actors: [], conditions, rules, ...extra,
});
const protectMain = handMade(11, "protect-main", MAIN, [{ type: "deletion" }, { type: "non_fast_forward" }]);
// The parameters GitHub returns for a pull_request rule made in its settings page.
const noPushToMain = handMade(12, "no-push-to-main", MAIN, [pullRequest({
  require_last_push_approval: false, require_extra_approval_for_unattributed_changes: false, required_reviewers: [],
})], { bypass_actors: ADMIN_BYPASS });
// Hand-made rulesets that together apply every policy rule.
const fullyHandMade = [
  protectMain,
  handMade(13, "hand-plans", PLANS, [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }]),
  handMade(14, "hand-merge", MAIN, [pullRequest(), statusChecks(CHECKS)], { bypass_actors: ADMIN_BYPASS }),
];

try {
  const gh = createFakeGh(root);
  const checkout = clone("checkout", "git@github.com:example/project.git");
  // A gh sign-in or token from the caller's shell would outrank the fixture's in fake gh.
  const runEnv = { ...process.env, ...gh.env, PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` };
  for (const name of ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN"]) delete runEnv[name];
  const run = (args, cwd = checkout) => {
    const result = spawnSync(process.execPath, [cli, "protect", ...args], { cwd, encoding: "utf8", env: runEnv });
    return { ...result, json: args.includes("--json") ? JSON.parse(result.stdout) : null };
  };
  const writes = () => gh.calls().filter((call) => call.method !== "GET");
  const start = (overrides) => {
    gh.setState(fakeGitHubState(overrides));
    gh.clearCalls();
  };
  const policy = (report, key) => report.policies.find((entry) => entry.key === key);

  // missing: nothing protects either branch.
  start();
  let result = run(["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /Branch protection for example\/project is missing/);
  assert.match(result.stdout, /roborepo-plans \(repo-plans\): not created; missing deletion, non_fast_forward, required_linear_history/);
  assert.match(result.stdout, /roborepo-main-integrity \(main\): not created; missing deletion, non_fast_forward/);
  assert.match(result.stdout, /roborepo-main-merge \(main\): not created; missing pull_request, required_status_checks/);
  assert.deepEqual(writes(), [], "--check never writes");
  result = run(["--check", "--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.state, "missing");
  assert.equal(result.json.admin, true);
  assert.deepEqual(result.json.policies.map((entry) => [entry.name, entry.status]), [
    ["roborepo-plans", "absent"], ["roborepo-main-integrity", "absent"], ["roborepo-main-merge", "absent"],
  ]);
  console.log("✓ An unprotected repo reads as missing and --check writes nothing.");

  // missing, admin: one create per absent managed ruleset, then a single re-read.
  gh.clearCalls();
  result = run([]);
  assert.equal(result.status, 0, result.stdout + result.stderr);
  assert.match(result.stdout, /Changes:\n {2}create roborepo-plans\n {2}create roborepo-main-integrity\n {2}create roborepo-main-merge\n/);
  assert.ok(result.stdout.indexOf("Changes:") < result.stdout.indexOf("Branch protection for"), "planned changes print before the final state");
  assert.match(result.stdout, /is protected/);
  assert.deepEqual(writes().map((call) => [call.method, call.endpoint]), [
    ["POST", "repos/example/project/rulesets"], ["POST", "repos/example/project/rulesets"], ["POST", "repos/example/project/rulesets"],
  ]);
  const [plansBody, integrityBody, mergeBody] = writes().map((call) => call.body);
  assert.deepEqual(plansBody, {
    name: "roborepo-plans", target: "branch", enforcement: "active", bypass_actors: [], conditions: PLANS,
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }, { type: "required_linear_history" }],
  });
  assert.deepEqual(integrityBody, {
    name: "roborepo-main-integrity", target: "branch", enforcement: "active", bypass_actors: [], conditions: MAIN,
    rules: [{ type: "deletion" }, { type: "non_fast_forward" }],
  });
  assert.deepEqual(mergeBody, {
    name: "roborepo-main-merge", target: "branch", enforcement: "active", bypass_actors: ADMIN_BYPASS, conditions: MAIN,
    rules: [
      { type: "pull_request", parameters: {
        required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews_on_push: false,
        require_code_owner_review: false, required_review_thread_resolution: false,
      } },
      statusChecks(CHECKS),
    ],
  });
  const lastWrite = gh.calls().findLastIndex((call) => call.method !== "GET");
  assert.ok(gh.calls().slice(lastWrite + 1).some((call) => call.endpoint.includes("rules/branches/main")), "the state is read again after the writes");
  gh.clearCalls();
  result = run(["--json"]);
  assert.equal(result.status, 0);
  assert.equal(result.json.state, "protected");
  assert.deepEqual(result.json.changes, []);
  assert.deepEqual(writes(), [], "a second run sends nothing");
  console.log("✓ protect creates the three managed rulesets with the policy bodies, then changes nothing on a second run.");

  // drifted: a renamed CI job leaves the managed merge ruleset behind the policy.
  const protectedState = gh.readState();
  const renamed = [{ id: 502, conclusion: "success", jobs: [{ name: "check (ubuntu-latest)", conclusion: "success" }, { name: "verify (macos-latest)", conclusion: "success" }] }];
  start({ ...protectedState, rulesets: [...protectedState.rulesets, protectMain], runs: renamed });
  result = run(["--check"]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is drifted/);
  assert.match(result.stdout, /roborepo-main-merge \(main\): differs from the policy: required checks differ \(not required yet: verify \(macos-latest\); no longer a CI job: check \(macos-latest\)\)/);
  result = run([]);
  assert.equal(result.status, 0, result.stdout);
  const mergeId = gh.readState().rulesets.find((ruleset) => ruleset.name === "roborepo-main-merge").id;
  assert.deepEqual(writes().map((call) => [call.method, call.endpoint]), [["PUT", `repos/example/project/rulesets/${mergeId}`]], "only the drifted managed ruleset is updated");
  assert.deepEqual(writes()[0].body.rules[1], statusChecks(["check (ubuntu-latest)", "verify (macos-latest)"]));
  assert.deepEqual(gh.readState().rulesets.find((ruleset) => ruleset.id === 11), protectMain, "the hand-made ruleset is untouched");
  // A managed ruleset someone disabled leaves its rules off the branch: that is missing, which
  // outranks drifted, and the drift detail still names why.
  const loosened = gh.readState();
  loosened.rulesets.find((ruleset) => ruleset.name === "roborepo-main-integrity").enforcement = "disabled";
  start({ ...loosened, rulesets: loosened.rulesets.filter((ruleset) => ruleset.id !== 11) });
  result = run(["--check", "--json"]);
  assert.equal(result.json.state, "missing");
  assert.deepEqual(policy(result.json, "main-integrity").drift, ["enforcement is disabled"]);
  assert.deepEqual(policy(result.json, "main-integrity").missingRules, ["deletion", "non_fast_forward"]);
  result = run([]);
  assert.equal(result.status, 0, result.stdout);
  assert.equal(writes().length, 1, "protect re-enables the disabled managed ruleset with one update");
  console.log("✓ A renamed CI job reads as drifted, a disabled managed ruleset as missing, and protect updates only the managed ruleset.");

  // unmanaged: hand-made rulesets apply every policy rule.
  start({ rulesets: structuredClone(fullyHandMade) });
  result = run(["--check"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /is unmanaged/);
  assert.match(result.stdout, /roborepo-main-merge \(main\): not created; hand-made rulesets apply its rules/);
  result = run([]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /is protected/);
  assert.equal(writes().length, 3);
  assert.ok(writes().every((call) => call.method === "POST" && call.body.name.startsWith("roborepo-")));
  assert.deepEqual(gh.readState().rulesets.filter((ruleset) => ruleset.id < 100), fullyHandMade, "hand-made rulesets are left as they were");
  for (const name of ["protect-main", "hand-plans", "hand-merge"]) {
    assert.match(result.stdout, new RegExp(`${name}: covered by the managed rulesets; safe to delete`));
  }
  console.log("✓ Hand-made protection reads as unmanaged; protect adds the managed rulesets beside it and reports the covered ones.");

  // Coverage: target, rules, enforcement, and bypass all have to line up.
  const managedOnly = gh.readState().rulesets.filter((ruleset) => ruleset.id >= 100);
  const coverage = (ruleset) => {
    start({ rulesets: [...structuredClone(managedOnly), ruleset] });
    return run(["--check", "--json"]).json.handMade.find((entry) => entry.id === ruleset.id);
  };
  assert.equal(coverage(noPushToMain).covered, true, "a looser pull_request rule with the same admin bypass is covered");
  const noBypass = coverage(handMade(21, "strict-reviews", MAIN, [pullRequest()]));
  assert.equal(noBypass.covered, false, "a pull_request ruleset with no bypass is never covered by roborepo-main-merge");
  assert.match(noBypass.note, /still needed for: pull_request/);
  assert.equal(coverage(handMade(22, "all-branches", { ref_name: { include: ["~ALL"], exclude: [] } }, [{ type: "deletion" }])).covered, false, "a wider target is not covered");
  assert.equal(coverage(handMade(23, "two-approvals", MAIN, [pullRequest({ required_approving_review_count: 2 })], { bypass_actors: ADMIN_BYPASS })).covered, false, "a stricter rule is not covered");
  assert.equal(coverage(handMade(24, "signed", MAIN, [{ type: "required_signatures" }])).covered, false, "a rule the policy lacks is not covered");
  assert.equal(coverage(handMade(28, "attributed-changes", MAIN, [pullRequest({ require_extra_approval_for_unattributed_changes: true })], { bypass_actors: ADMIN_BYPASS })).covered, false, "a requirement the managed rule lacks is not covered");
  assert.equal(coverage(handMade(29, "squash-only", MAIN, [pullRequest({ allowed_merge_methods: ["squash"] })], { bypass_actors: ADMIN_BYPASS })).covered, false, "fewer allowed merge methods is stricter");
  const oneAppCheck = { type: "required_status_checks", parameters: { strict_required_status_checks_policy: false, required_status_checks: [{ context: CHECKS[0], integration_id: 15368 }] } };
  assert.equal(coverage(handMade(30, "one-app-check", MAIN, [oneAppCheck], { bypass_actors: ADMIN_BYPASS })).covered, false, "a check tied to one app is stricter");
  assert.equal(coverage(handMade(25, "explicit-main", { ref_name: { include: ["refs/heads/main"], exclude: [] } }, [{ type: "non_fast_forward" }])).covered, true, "the default branch named explicitly is the same target");
  const disabled = coverage(handMade(26, "paused", MAIN, [{ type: "deletion" }], { enforcement: "disabled" }));
  assert.deepEqual([disabled.covered, disabled.note], [false, "not enforced (disabled)"]);
  const organization = coverage({ id: 27, name: "org-baseline", target: "branch", source_type: "Organization", source: "example", enforcement: "active" });
  assert.deepEqual([organization.covered, organization.note], [false, "set by the organization"]);
  // A managed ruleset that excludes the branch it should protect covers nothing there.
  const narrowed = structuredClone(managedOnly);
  narrowed.find((ruleset) => ruleset.name === "roborepo-main-integrity").conditions.ref_name.exclude = ["refs/heads/main"];
  start({ rulesets: [...narrowed, protectMain] });
  assert.equal(run(["--check", "--json"]).json.handMade.find((entry) => entry.id === protectMain.id).covered, false, "an excluded branch on the managed side is not covered");
  // Hidden bypass lists prove nothing, so a non-admin never sees a ruleset called safe to delete.
  start({ admin: false, login: "octo-reader", rulesets: [...structuredClone(managedOnly), protectMain] });
  const hidden = run(["--check", "--json"]).json.handMade.find((entry) => entry.id === protectMain.id);
  assert.equal(hidden.covered, false);
  assert.match(hidden.note, /cannot see who may bypass them/);
  console.log("✓ A hand-made ruleset is covered only when target, rules, enforcement, and bypass all match.");

  // Required checks combine the newest successful pull-request run of each active workflow.
  start({ runs: [
    { id: 610, conclusion: "cancelled", jobs: [{ name: "half-finished", conclusion: "cancelled" }] },
    { id: 609, conclusion: "failure", jobs: [{ name: "broken", conclusion: "failure" }] },
    { id: 608, conclusion: "success", jobs: [{ name: "build", conclusion: "success" }, { name: "docs-only", conclusion: "skipped" }] },
    { id: 607, conclusion: "success", jobs: [{ name: "older-build", conclusion: "success" }] },
  ] });
  result = run(["--json"]);
  assert.deepEqual(result.json.requiredChecks, ["build"], "only a workflow's newest successful run counts; cancelled and failed runs, and skipped jobs, are passed over");
  assert.equal(result.json.checksSource, "pull-requests");
  assert.deepEqual(writes()[2].body.rules[1], statusChecks(["build"]));

  start({
    runs: [
      { id: 705, conclusion: "success", event: "push", workflow: 3, jobs: [{ name: "publish", conclusion: "success" }] },
      { id: 704, conclusion: "success", workflow: 2, jobs: [{ name: "lint", conclusion: "success" }] },
      { id: 703, conclusion: "success", workflow: 4, jobs: [{ name: "retired-check", conclusion: "success" }] },
      { id: 702, conclusion: "success", workflow: 1, jobs: [{ name: "build", conclusion: "success" }] },
    ],
    workflows: [{ id: 1, state: "active" }, { id: 2, state: "active" }, { id: 3, state: "active" }, { id: 4, state: "disabled_manually" }],
  });
  result = run(["--check", "--json"]);
  assert.deepEqual(result.json.requiredChecks, ["build", "lint"], "every pull-request workflow counts; a push-only workflow and a disabled one do not");

  // A quiet workflow whose newest run sits behind 150 newer runs of a busy one still counts.
  const busy = Array.from({ length: 150 }, (_, index) => ({ id: 2000 - index, conclusion: "success", workflow: 1, jobs: [{ name: "build", conclusion: "success" }] }));
  start({ runs: [...busy, { id: 800, conclusion: "success", workflow: 2, jobs: [{ name: "nightly-lint", conclusion: "success" }] }] });
  assert.deepEqual(run(["--check", "--json"]).json.requiredChecks, ["build", "nightly-lint"]);

  // A run with more jobs than one page holds (a large matrix) contributes every job.
  const shards = Array.from({ length: 130 }, (_, index) => ({ name: `shard ${String(index).padStart(3, "0")}`, conclusion: "success" }));
  start({ runs: [{ id: 950, conclusion: "success", jobs: shards }] });
  assert.deepEqual(run(["--check", "--json"]).json.requiredChecks, shards.map((job) => job.name));
  assert.ok(gh.calls().every((call) => call.hostname === "github.com"), "every call names github.com, whatever GH_HOST says");

  // No successful pull-request run and no managed merge ruleset: the status-check rule is left out.
  start({ runs: [{ id: 611, conclusion: "failure", jobs: [{ name: "broken", conclusion: "failure" }] }] });
  result = run([]);
  assert.equal(result.status, 0);
  assert.deepEqual(writes()[2].body.rules.map((rule) => rule.type), ["pull_request"], "no successful run leaves the status-check rule out");
  assert.match(result.stdout, /Required CI checks: none\. No workflow has a successful pull-request run/);

  // With a managed merge ruleset already requiring checks, finding no run keeps them: nothing drifts
  // and nothing is written, whether the runs aged out or Actions was turned off (404).
  start();
  assert.equal(run([]).status, 0);
  const guarded = gh.readState();
  const allSkipped = [{ id: 900, conclusion: "success", jobs: [{ name: "check (ubuntu-latest)", conclusion: "skipped" }] }];
  for (const overrides of [{ runs: [] }, { failure: "actions-off" }, { runs: allSkipped }]) {
    start({ ...guarded, ...overrides });
    result = run(["--check", "--json"]);
    assert.deepEqual([result.json.state, result.json.checksSource, result.json.requiredChecks], ["protected", "kept", ["check (macos-latest)", "check (ubuntu-latest)"]]);
    result = run([]);
    assert.equal(result.status, 0);
    assert.match(result.stdout, /Required CI checks: check \(macos-latest\), check \(ubuntu-latest\) \(kept from roborepo-main-merge/);
    assert.deepEqual(writes(), [], "protect never removes required checks it cannot read again");
  }
  start({ failure: "actions-off" });
  result = run(["--check", "--json"]);
  assert.deepEqual([result.json.state, result.json.requiredChecks, result.json.checksSource], ["missing", [], "none"], "Actions off with no managed ruleset has nothing to keep");

  // Any other runs error must not be read as "no run": protect would drop the required checks.
  start({ ...guarded, failure: "runs-error" });
  result = run([]);
  assert.equal(result.status, 1);
  assert.equal(run(["--check", "--json"]).json.state, "unavailable");
  assert.deepEqual(writes(), [], "a failed runs read writes nothing");
  console.log("✓ Required checks combine each workflow's newest pull-request run, existing checks are kept when none is found, and a failed runs read is unavailable.");

  // Not an admin: every state is reported, nothing is written, and the account is named.
  start({ admin: false, login: "octo-reader" });
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is missing/);
  assert.match(result.stdout, /Signed in to GitHub as octo-reader, who is not an admin of example\/project; a repo admin must run roborepo protect\./);
  assert.deepEqual(writes(), []);
  result = run(["--check", "--json"]);
  assert.deepEqual([result.json.state, result.json.admin, result.json.login], ["missing", false, "octo-reader"]);
  start({ admin: false, login: "octo-reader", rulesets: [...structuredClone(managedOnly), noPushToMain] });
  result = run(["--check"]);
  assert.equal(result.status, 0);
  assert.match(result.stdout, /Bypass lists are visible only to admins, so they were not compared\./);
  result = run(["--skip", "main-merge"]);
  assert.match(result.stdout, /Signed in to GitHub as octo-reader, who is not an admin/);
  assert.deepEqual(writes(), []);
  console.log("✓ A non-admin gets the state and the account name, and no write is sent.");

  // Skipping the merge policy lives on GitHub, so another clone reads the same answer.
  start({ rulesets: structuredClone(managedOnly) });
  result = run(["--skip", "main-merge"]);
  assert.equal(result.status, 0, result.stdout);
  assert.match(result.stdout, /update roborepo-main-merge \(disabled\)/);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].body.enforcement, "disabled");
  assert.deepEqual(writes()[0].body.rules.map((rule) => rule.type), ["pull_request", "required_status_checks"], "a skipped ruleset keeps its policy rules");
  const secondClone = clone("second-clone", "https://github.com/example/project.git");
  gh.clearCalls();
  result = run(["--check", "--json"], secondClone);
  assert.equal(result.status, 0);
  assert.equal(result.json.state, "protected");
  assert.equal(policy(result.json, "main-merge").status, "skipped");
  result = run([], secondClone);
  assert.deepEqual(writes(), [], "protect never re-enables a skipped policy");
  result = run(["--unskip", "main-merge"]);
  assert.equal(result.status, 0);
  assert.equal(writes().length, 1);
  assert.equal(writes()[0].body.enforcement, "active");
  assert.equal(policy(run(["--check", "--json"]).json, "main-merge").status, "ok");
  start();
  result = run(["--skip", "main-merge"]);
  assert.deepEqual(writes().map((call) => [call.method, call.body.name, call.body.enforcement]), [["POST", "roborepo-main-merge", "disabled"]], "skipping before protecting creates only the disabled merge ruleset");
  assert.equal(result.status, 1, "the plans and integrity rules are still missing");
  // A refused --unskip leaves the state protected (merge rules still skipped) but fails the run.
  const skippedRulesets = structuredClone(managedOnly);
  skippedRulesets.find((ruleset) => ruleset.name === "roborepo-main-merge").enforcement = "disabled";
  start({ rulesets: skippedRulesets, refuseUpdate: "roborepo-main-merge" });
  result = run(["--unskip", "main-merge", "--json"]);
  assert.equal(result.json.state, "protected");
  assert.equal(result.json.refusal, "GitHub refused to update roborepo-main-merge: Validation Failed");
  assert.equal(result.status, 1, "a refused write exits 1 even when the state reads protected");
  console.log("✓ --skip main-merge disables the managed merge ruleset for every clone, and --unskip restores it.");

  // conflicting: a rule that can refuse a plan save reaches the plans branch.
  const wide = handMade(31, "everything-needs-review", { ref_name: { include: ["~ALL"], exclude: [] } }, [pullRequest()]);
  start({ rulesets: [...structuredClone(managedOnly), wide] });
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is conflicting/);
  assert.match(result.stdout, /Rule pull_request from ruleset everything-needs-review reaches the repo-plans branch and will refuse plan saves\. Exclude that branch from the ruleset\./);
  assert.deepEqual(writes(), []);
  result = run(["--skip", "main-merge"]);
  assert.match(result.stdout, /Nothing was changed while the state is conflicting\./);
  assert.deepEqual(writes(), []);
  console.log("✓ A push-blocking rule on the plans branch reads as conflicting, naming the rule and ruleset.");

  // Classic branch protection on the plans branch is outside rulesets but refuses saves just the same.
  const classicReviews = { "repo-plans": {
    required_pull_request_reviews: { required_approving_review_count: 1 },
    required_signatures: { enabled: false }, allow_force_pushes: { enabled: false }, allow_deletions: { enabled: false },
  } };
  start({ rulesets: structuredClone(managedOnly), classicProtection: classicReviews });
  result = run(["--json"]);
  assert.equal(result.status, 1);
  assert.equal(result.json.state, "conflicting");
  assert.deepEqual(result.json.conflicts.map((conflict) => [conflict.source, conflict.rule]), [["branch-protection", "required_pull_request_reviews"]]);
  assert.match(result.json.conflicts[0].detail, /branch protection setting "require a pull request before merging" will refuse plan saves/);
  assert.deepEqual(writes(), []);
  // Settings that never refuse a fast-forward push are not conflicts.
  start({ rulesets: structuredClone(managedOnly), classicProtection: { "repo-plans": {
    required_signatures: { enabled: false }, allow_force_pushes: { enabled: false }, required_linear_history: { enabled: true },
  } } });
  assert.equal(run(["--check", "--json"]).json.state, "protected");
  // A non-admin cannot read classic protection; the state comes from the rulesets alone.
  start({ admin: false, login: "octo-reader", rulesets: structuredClone(managedOnly), classicProtection: classicReviews });
  assert.equal(run(["--check", "--json"]).json.state, "protected");
  // A plan without branch protection answers 403 with the upgrade message: nothing to report.
  start({ rulesets: structuredClone(managedOnly), classicProtection: classicReviews, failure: "classic-refused" });
  assert.equal(run(["--check", "--json"]).json.state, "protected");
  // A rate limit is also a 403, but it hides the settings, so the read cannot claim no conflict.
  start({ rulesets: structuredClone(managedOnly), classicProtection: classicReviews, failure: "classic-rate-limited" });
  result = run(["--check", "--json"]);
  assert.equal(result.json.state, "unavailable");
  assert.match(result.json.reason, /rate limit/);
  console.log("✓ Classic branch protection that refuses a push on the plans branch reads as conflicting.");

  // A hand-made ruleset that admins can bypass does not supply a no-bypass policy rule.
  const bypassable = structuredClone(fullyHandMade).map((ruleset) => ruleset.name === "protect-main" ? { ...ruleset, bypass_actors: ADMIN_BYPASS } : ruleset);
  start({ rulesets: bypassable });
  result = run(["--check", "--json"]);
  assert.equal(result.json.state, "missing");
  assert.deepEqual(policy(result.json, "main-integrity").missingRules, ["deletion", "non_fast_forward"]);
  assert.match(policy(result.json, "main-integrity").detail, /hand-made rulesets apply deletion, non_fast_forward, but let more people bypass them/);
  assert.equal(policy(result.json, "plans").missingRules.length, 0, "the plans branch's no-bypass ruleset still counts");
  console.log("✓ A hand-made rule counts toward a policy only when its ruleset's bypass list is no wider.");

  // unavailable: no answer from GitHub.
  for (const [failure, reason] of [["not-signed-in", /not signed in \(run: gh auth login\)/], ["unreachable", /GitHub could not be reached/]]) {
    start({ failure });
    result = run([]);
    assert.equal(result.status, 1);
    assert.match(result.stdout, /is unavailable/);
    assert.match(result.stdout, reason);
    assert.equal(run(["--check", "--json"]).json.state, "unavailable");
    assert.deepEqual(writes(), []);
  }
  // A GitHub that never answers ends at the caller's timeout, which is how the portal bounds a read.
  start({ failure: "hang" });
  Object.assign(process.env, gh.env, { PATH: `${gh.dir}${path.delimiter}${process.env.PATH}` });
  const { readProtection } = await import("../../modules/forge/protection.mjs");
  const slow = await readProtection({ repositoryId: "git:github.com/example/project", cwd: checkout, timeoutMs: 300 });
  assert.deepEqual([slow.state, slow.reason], ["unavailable", "GitHub did not answer in time"]);
  console.log("✓ A signed-out, unreachable, or unanswering GitHub reads as unavailable.");

  // GitHub refusing one write partway: the earlier write stands, the rest are not sent, the
  // refusal is reported, and the state is read once more.
  start({ refuseCreate: "roborepo-main-integrity" });
  result = run(["--json"]);
  assert.equal(result.status, 1);
  assert.deepEqual(result.json.changes, [{ action: "create", name: "roborepo-plans", enforcement: "active" }]);
  assert.equal(result.json.refusal, "GitHub refused to create roborepo-main-integrity: Validation Failed");
  assert.equal(result.json.state, "missing");
  assert.deepEqual(writes().map((call) => call.body.name), ["roborepo-plans", "roborepo-main-integrity"], "nothing is sent after the refused write");
  assert.deepEqual(gh.readState().rulesets.map((ruleset) => ruleset.name), ["roborepo-plans"]);
  console.log("✓ A write GitHub refuses partway stops the apply, keeps earlier writes, and reports the refusal.");

  // unsupported: GitHub refuses rulesets for the repo, or the remote is another host.
  start({ failure: "rulesets-refused" });
  result = run([]);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is unsupported/);
  assert.ok(result.stdout.includes(`GitHub does not offer rulesets for this repo: ${RULESETS_REFUSED_MESSAGE}`));
  assert.match(result.stdout, /Protect the branches by hand/);
  assert.deepEqual(writes(), []);
  assert.equal(run(["--skip", "main-merge"]).status, 1);
  assert.deepEqual(writes(), []);
  const elsewhere = clone("gitlab-clone", "git@gitlab.com:example/project.git");
  start();
  result = run([], elsewhere);
  assert.equal(result.status, 1);
  assert.match(result.stdout, /is unsupported/);
  assert.match(result.stdout, /gitlab\.com is not GitHub/);
  assert.match(result.stdout, /1\. On the repo-plans branch: block deletion, block force pushes, and require linear history\./);
  assert.deepEqual(gh.calls(), [], "another host never calls gh");
  console.log("✓ A repo GitHub offers no rulesets for, or on another host, reads as unsupported with the manual steps.");

  // Across every run above, no request edited or deleted a ruleset RoboRepo does not manage.
  start({ rulesets: structuredClone(fullyHandMade) });
  run([]);
  run(["--skip", "main-merge"]);
  run(["--unskip", "main-merge"]);
  const managedIds = new Set(gh.readState().rulesets.filter((ruleset) => ruleset.name.startsWith("roborepo-")).map((ruleset) => String(ruleset.id)));
  for (const call of writes()) {
    assert.notEqual(call.method, "DELETE");
    if (call.method === "PUT") assert.ok(managedIds.has(call.endpoint.split("/").pop()), `update went to a managed ruleset: ${call.endpoint}`);
    else assert.ok(call.body.name.startsWith("roborepo-"));
  }
  console.log("✓ Only roborepo-* rulesets were ever created or updated.");

  // Usage errors change nothing.
  start();
  for (const args of [["--skip", "plans"], ["--check", "--skip", "main-merge"], ["--force"], ["--skip"]]) {
    result = run(args);
    assert.equal(result.status, 2, args.join(" "));
    assert.match(result.stderr, /Usage: roborepo protect/);
  }
  assert.deepEqual(gh.calls(), []);
  console.log("✓ Unknown flags and unsupported skips are refused before any GitHub call.");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function clone(name, origin) {
  const dir = path.join(root, name);
  const git = (...args) => {
    const result = spawnSync("git", args, { cwd: root, encoding: "utf8" });
    assert.equal(result.status, 0, result.stderr);
  };
  git("init", "-q", "-b", "main", dir);
  git("-C", dir, "remote", "add", "origin", origin);
  return dir;
}
