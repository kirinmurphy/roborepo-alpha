// `roborepo github status`: reads whether agents act on GitHub as a safe bot account. The guided
// setup that fixes what this reports is `roborepo github setup` (github-setup.mjs).
import { GitHubError, forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { githubClient } from "../../modules/forge/github.mjs";
import { botGhEnv, readAccountIdentity, readAgentIdentity, readRepoAgentAccess } from "../../modules/forge/agent-identity.mjs";
import { agentGitRoutingGaps, agentIdentityPackageEnabled } from "./agent-identity-package.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";

const USAGE = "Usage: roborepo github status [--json]";
// Doctor waits on these reads, so each gives up sooner than an explicit `roborepo github status`.
const DOCTOR_TIMEOUT_MS = 8000;

// `repositoryId` skips reading `cwd`'s origin when the caller already knows the repo (the portal).
export async function readCurrentAgentIdentity({ cwd = process.cwd(), timeoutMs, repositoryId: known = null } = {}) {
  const repositoryId = known ?? await currentRepositoryId(cwd);
  return readAgentIdentity({ repositoryId, cwd, stateDir, timeoutMs, packageEnabled: agentIdentityPackageEnabled(), gitGaps: agentGitRoutingGaps() });
}

// Invites the bot to one repo as the user and accepts the invitation as the bot: the setup's invite
// steps, which need no typing, so the portal can run them. Only a repo admin can invite; anyone else
// gets `ok: false` and GitHub's reason, and the card's message for the owner says the rest.
export async function inviteBotToRepo({ repositoryId, cwd = process.cwd(), timeoutMs, botLogin }) {
  const repo = forgeTargetForRepositoryId(repositoryId)?.repo;
  if (!repo) return { ok: false, message: "This repo is not on github.com." };
  const user = { cwd, timeoutMs, env: { GH_CONFIG_DIR: null } };
  const bot = { cwd, timeoutMs, env: botGhEnv(stateDir) };
  try {
    if (!(await githubClient.isCollaborator(user, repo, botLogin))) {
      const invited = (await githubClient.repoInvitations(user, repo)).some((invitation) => invitation.invitee?.login?.toLowerCase() === botLogin.toLowerCase());
      if (!invited) await githubClient.inviteCollaborator(user, repo, botLogin);
    }
    const pending = (await githubClient.userInvitations(bot)).find((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());
    if (pending) await githubClient.acceptInvitation(bot, pending.id);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return { ok: false, message: `GitHub refused: ${error.message}. Only an admin of the repo can invite the bot.` };
  }
  return { ok: true };
}

// The bot account alone, and one repo for a known bot: the two halves the portal shows apart.
export const readCurrentAccountIdentity = ({ cwd = process.cwd(), timeoutMs } = {}) =>
  readAccountIdentity({ cwd, stateDir, timeoutMs, packageEnabled: agentIdentityPackageEnabled(), gitGaps: agentGitRoutingGaps() });
export const readCurrentRepoAgentAccess = ({ repositoryId, cwd = process.cwd(), timeoutMs, botLogin }) =>
  readRepoAgentAccess({ repositoryId, cwd, stateDir, timeoutMs, botLogin });

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
        : report.state === "unverified"
          ? `GitHub agent identity${repo}: agents act as ${report.botLogin}, but the branch rules could not be verified:`
          : `GitHub agent identity has problems${repo}:`;
      return [headline, ...problemLines(report.problems), ...ownerLines(report.ownerMessage)].join("\n");
    }
  }
}

const SEVERITY_LABEL = { warn: "Note", unchecked: "Not checked", unverified: "Unverified", problem: "Problem" };

// The message for the owner of a repo you do not administer, set off so it can be copied whole.
const ownerLines = (message) => (message ? ["", "Message for the repo's owner:", ...message.split("\n").map((line) => `  ${line}`.trimEnd())] : []);

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
    case "unverified": {
      const first = report.problems.find((entry) => entry.severity === "unverified");
      return { level: "hint", text: `GitHub agent identity for ${repo}: ${first.message} — ${fixClause(first.fix)}` };
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
