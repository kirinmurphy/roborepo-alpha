// `roborepo protect`: report whether the current repo's plans and default branches match the
// managed protection policy on GitHub and, unless --check is given, make them match.
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { normalizeGitRemote } from "../../modules/repositories/identity.mjs";
import { forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { MERGE_POLICY_KEY } from "../../modules/forge/protection-policy.mjs";
import { PROTECTED_STATES, applyProtection, readProtection } from "../../modules/forge/protection.mjs";
import { isMainModule } from "./roots.mjs";

const USAGE = "Usage: roborepo protect [--check] [--json] [--skip main-merge | --unskip main-merge]";
// Doctor waits on this read, so it gives up sooner than an explicit `roborepo protect` run.
const DOCTOR_TIMEOUT_MS = 8000;

export async function protectCommand(argv) {
  let options;
  try {
    options = parseArgs(argv);
  } catch (error) {
    console.error(`${error.message}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const target = { repositoryId: await currentRepositoryId(process.cwd()), cwd: process.cwd() };
  const result = options.check
    ? { report: await readProtection(target), changes: [], refusal: null }
    : await applyProtection(target, {
      action: options.action,
      onPlanned: (changes) => { if (!options.json) console.log(formatChanges(changes)); },
    });
  if (options.json) {
    const changes = result.changes.map(({ action, name, enforcement }) => ({ action, name, enforcement }));
    console.log(JSON.stringify({ ...result.report, changes, refusal: result.refusal }, null, 2));
  } else {
    console.log(formatReport(result.report));
    if (result.refusal) console.log(`\n${capitalize(result.refusal)}.`);
  }
  process.exitCode = PROTECTED_STATES.has(result.report.state) ? 0 : 1;
}

function parseArgs(argv) {
  const options = { check: false, json: false, action: "protect" };
  const args = [...argv];
  while (args.length > 0) {
    const arg = args.shift();
    if (arg === "--check") options.check = true;
    else if (arg === "--json") options.json = true;
    else if (arg === "--skip" || arg === "--unskip") {
      if (options.action !== "protect") throw new Error("Use only one of --skip and --unskip.");
      const policy = args.shift();
      if (policy !== MERGE_POLICY_KEY) throw new Error(`Only ${MERGE_POLICY_KEY} can be skipped; the plans and integrity rules have no opt-out.`);
      options.action = arg.slice(2);
    } else throw new Error(`Unknown option: ${arg}`);
  }
  if (options.check && options.action !== "protect") throw new Error("--check changes nothing and cannot be combined with --skip or --unskip.");
  return options;
}

// The canonical id of the repo `cwd` is in, from its `origin` remote; null outside a Git repo or
// without an origin.
async function currentRepositoryId(cwd) {
  const top = await runGitProcess(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const origin = await runGitProcess(top.stdout.trim(), ["remote", "get-url", "origin"]);
  return origin.ok ? normalizeGitRemote(origin.stdout.trim()) : null;
}

const STATE_SUMMARY = {
  protected: "protected: both branches match the RoboRepo policy",
  unmanaged: "unmanaged: both branches are protected, but by hand-made rulesets rather than RoboRepo's",
  missing: "missing: part of the policy does not apply yet",
  drifted: "drifted: a RoboRepo ruleset no longer matches the policy",
  conflicting: `conflicting: a rule on the plans branch will refuse plan saves`,
  unavailable: "unavailable: GitHub could not be read",
  unsupported: "unsupported: RoboRepo cannot manage protection for this repo",
};

function formatReport(report) {
  const lines = [`Branch protection${report.repository ? ` for ${report.repository}` : ""} is ${STATE_SUMMARY[report.state]}.`];
  if (report.reason) lines.push(`  Reason: ${report.reason}`);
  for (const policy of report.policies) lines.push(`  ${policy.name} (${policy.branch}): ${describePolicy(policy)}`);
  for (const conflict of report.conflicts) {
    lines.push(`  Rule ${conflict.rule} from ruleset ${conflict.ruleset} reaches the plans branch. Exclude that branch from the ruleset.`);
  }
  if (report.policies.length > 0) {
    lines.push(report.requiredChecks.length > 0
      ? `  Required CI checks: ${report.requiredChecks.join(", ")}`
      : `  Required CI checks: none. ${report.defaultBranch} has no successful CI run to read job names from, so merges are not held for CI.`);
  }
  if (report.handMade.length > 0) {
    lines.push("  Other rulesets:");
    for (const ruleset of report.handMade) lines.push(`    ${ruleset.name}: ${ruleset.note}`);
    if (!report.bypassVisible) lines.push("    Bypass lists are visible only to admins, so they were not compared.");
  }
  if (report.manualSteps) {
    lines.push("  Protect the branches by hand on your Git host:");
    report.manualSteps.forEach((step, index) => lines.push(`    ${index + 1}. ${step}`));
  }
  return lines.join("\n");
}

function describePolicy(policy) {
  if (policy.status === "skipped") return "skipped (turned off for this repo; roborepo protect --unskip main-merge turns it back on)";
  if (policy.status === "ok") return "matches the policy";
  if (policy.status === "drifted") return `differs from the policy: ${policy.drift.join("; ")}`;
  return policy.missingRules.length > 0
    ? `not created; missing ${policy.missingRules.join(", ")}`
    : "not created; hand-made rulesets apply its rules";
}

function formatChanges(changes) {
  const lines = changes.map((change) => `  ${change.action} ${change.name}${change.enforcement === "disabled" ? " (disabled)" : ""}`);
  return `Changes:\n${lines.join("\n")}\n`;
}

const capitalize = (text) => text.charAt(0).toUpperCase() + text.slice(1);

// Doctor's one line for a report: advisory (`hint`) when the user can act, `ok` otherwise.
export function doctorLine(report) {
  const repo = report.repository;
  const adminAction = report.admin ? "run: roborepo protect" : `a repo admin must run: roborepo protect (signed in as ${report.login})`;
  switch (report.state) {
    case "protected": {
      const skipped = report.policies.some((policy) => policy.status === "skipped") ? "; merge rules are skipped for this repo" : "";
      return { level: "ok", text: `branch protection matches the RoboRepo policy for ${repo}${skipped}` };
    }
    case "unmanaged":
      return { level: "ok", text: `${repo} branches are protected by hand-made rulesets (${report.handMade.map((ruleset) => ruleset.name).join(", ")}); roborepo protect would manage them` };
    case "missing":
      return { level: "hint", text: `branch protection is incomplete for ${repo} — ${adminAction}` };
    case "drifted":
      return { level: "hint", text: `branch protection has drifted from the RoboRepo policy for ${repo} — ${adminAction}` };
    case "conflicting": {
      const [conflict] = report.conflicts;
      return { level: "hint", text: `rule ${conflict.rule} from ruleset ${conflict.ruleset} will refuse plan saves in ${repo} — exclude the plans branch from that ruleset` };
    }
    case "unsupported":
      return { level: "hint", text: `RoboRepo cannot manage branch protection for ${repo} (${report.reason}) — run roborepo protect --check for the manual steps` };
    default:
      return { level: "ok", text: `branch protection check skipped (${report.reason})` };
  }
}

// --doctor is scripts/doctor.sh's contract, run directly like node-release-health.mjs: one line,
// exit 0 for an `ok` line and 1 for a `hint` line. It prints nothing, exit 0, when the current
// directory is not a Git repo with a GitHub origin, so doctor adds no line there.
async function doctorMode() {
  const repositoryId = await currentRepositoryId(process.cwd());
  if (forgeTargetForRepositoryId(repositoryId)?.host !== "github.com") return 0;
  const { level, text } = doctorLine(await readProtection({ repositoryId, cwd: process.cwd(), timeoutMs: DOCTOR_TIMEOUT_MS }));
  console.log(text);
  return level === "hint" ? 1 : 0;
}

if (isMainModule(import.meta.url)) {
  if (!process.argv.includes("--doctor")) {
    console.error("usage: node protect.mjs --doctor");
    process.exit(2);
  }
  process.exit(await doctorMode());
}
