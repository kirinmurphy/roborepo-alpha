// `roborepo github status`: reads whether agents act on GitHub as a safe bot account. The guided
// setup that fixes what this reports is `roborepo github setup` (github-setup.mjs).
import { forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { readAgentIdentity } from "../../modules/forge/agent-identity.mjs";
import { agentIdentityPackageEnabled } from "./agent-identity-package.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";

const USAGE = "Usage: roborepo github status [--json]";
// Doctor waits on these reads, so each gives up sooner than an explicit `roborepo github status`.
const DOCTOR_TIMEOUT_MS = 8000;

// `repositoryId` skips reading `cwd`'s origin when the caller already knows the repo (the portal).
export async function readCurrentAgentIdentity({ cwd = process.cwd(), timeoutMs, repositoryId: known = null } = {}) {
  const repositoryId = known ?? await currentRepositoryId(cwd);
  return readAgentIdentity({ repositoryId, cwd, stateDir, timeoutMs, packageEnabled: agentIdentityPackageEnabled() });
}

export async function githubStatusCommand(argv) {
  const rest = argv.filter((arg) => arg !== "--json");
  if (rest.length > 0) {
    console.error(`Unknown option: ${rest[0]}\n${USAGE}`);
    process.exitCode = 2;
    return;
  }
  const report = await readCurrentAgentIdentity();
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report));
  process.exitCode = report.state === "problem" ? 1 : 0;
}

export function formatReport(report) {
  const repo = report.repository ? ` for ${report.repository}` : "";
  switch (report.state) {
    case "not-set-up":
      return "GitHub agent identity is not set up (optional). Run roborepo github setup in your own terminal to let agents act on GitHub as a bot account.";
    case "unavailable":
      if (report.problems?.length > 0) return [`GitHub agent identity could not be fully checked${repo}:`, ...problemLines(report.problems)].join("\n");
      return `GitHub agent identity could not be checked${repo}: ${report.reason}. Nothing is wrong that this check can see.`;
    default: {
      const headline = report.state === "healthy"
        ? `GitHub agent identity is healthy${repo}: agents act as ${report.botLogin}.`
        : `GitHub agent identity has problems${repo}:`;
      return [headline, ...problemLines(report.problems)].join("\n");
    }
  }
}

const SEVERITY_LABEL = { warn: "Note", unchecked: "Not checked", problem: "Problem" };

function problemLines(problems) {
  return problems.flatMap((entry) => [`  ${SEVERITY_LABEL[entry.severity] || "Problem"}: ${entry.message}`, `    Fix: ${entry.fix}`]);
}

// A problem's own fix, as the tail of doctor's line: "Run roborepo protect." -> "run roborepo protect".
const fixClause = (fix) => fix.replace(/\.$/, "").replace(/^[A-Z]/, (letter) => letter.toLowerCase());

// Doctor's one line for a report: `hint` when the user can act, `ok` otherwise. A hint names the
// first problem and that problem's fix, which is not always the setup command (`roborepo protect`).
export function doctorLine(report) {
  const repo = report.repository;
  switch (report.state) {
    case "not-set-up":
      return { level: "ok", text: "GitHub agent identity not set up (optional) — run roborepo github setup in your own terminal" };
    case "healthy": {
      const warn = report.problems[0];
      if (warn) return { level: "hint", text: `GitHub agent identity for ${repo}: ${warn.message} — ${fixClause(warn.fix)}` };
      return { level: "ok", text: `GitHub agent identity: agents act as ${report.botLogin} on ${repo}` };
    }
    case "problem": {
      const first = report.problems.find((entry) => entry.severity === "problem");
      return { level: "hint", text: `GitHub agent identity problem for ${repo}: ${first.message} — ${fixClause(first.fix)}` };
    }
    default: {
      // A check that could not run is something you can act on; GitHub being unreachable is not.
      const unchecked = report.problems?.find((entry) => entry.severity === "unchecked");
      if (unchecked) return { level: "hint", text: `GitHub agent identity for ${repo} not fully checked: ${unchecked.message} — ${fixClause(unchecked.fix)}` };
      return { level: "ok", text: `GitHub agent identity check skipped (${report.reason})` };
    }
  }
}

// --doctor is scripts/doctor.sh's contract, as in protect.mjs: one line, exit 0 for an `ok` line
// and 1 for a `hint`; nothing, exit 0, outside a Git repo with a GitHub origin; exit 3 on a crash.
async function doctorMode() {
  try {
    const repositoryId = await currentRepositoryId(process.cwd());
    if (forgeTargetForRepositoryId(repositoryId)?.host !== "github.com") return 0;
    const { level, text } = doctorLine(await readCurrentAgentIdentity({ timeoutMs: DOCTOR_TIMEOUT_MS }));
    console.log(text);
    return level === "hint" ? 1 : 0;
  } catch (error) {
    console.log(String(error?.message || error));
    return 3;
  }
}

if (isMainModule(import.meta.url)) {
  if (!process.argv.includes("--doctor")) {
    console.error("usage: node github-identity.mjs --doctor");
    process.exit(2);
  }
  process.exit(await doctorMode());
}
