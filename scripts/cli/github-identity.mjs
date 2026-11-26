// `roborepo github status`: reads whether agents act on GitHub as a safe bot account. The guided
// setup that fixes what this reports is `roborepo github setup` (github-setup.mjs).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GitHubError, forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { githubClient } from "../../modules/forge/github.mjs";
import { agentHostsFile, botGhEnv, readAccountIdentity, readAgentHosts, readAgentIdentity, readRepoAgentAccess } from "../../modules/forge/agent-identity.mjs";
import { AGENT_GITCONFIG_INCLUDE, agentGitRoutingGaps, agentIdentityPackageEnabled, includesAgentGitConfig } from "./agent-identity-package.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";

const USAGE = "Usage: roborepo github status [--json]";
// Doctor waits on these reads, so each gives up sooner than an explicit `roborepo github status`.
const DOCTOR_TIMEOUT_MS = 8000;

// `repositoryId` skips reading `cwd`'s origin when the caller already knows the repo (the portal).
export async function readCurrentAgentIdentity({ cwd = process.cwd(), timeoutMs, repositoryId: known = null } = {}) {
  const repositoryId = known ?? await currentRepositoryId(cwd);
  const packageEnabled = agentIdentityPackageEnabled();
  return readAgentIdentity({
    repositoryId, cwd, stateDir, timeoutMs, packageEnabled, gitGaps: agentGitRoutingGaps(), gitconfigMissing: packageEnabled && agentGitconfigMissing(),
  });
}

// Whether the Git settings file agents' Git includes is gone. Git resolves the include's `~` from
// HOME and skips a missing file without a word, so agents' pushes would go out as you.
const agentGitconfigMissing = () => !fs.existsSync(path.join(os.homedir(), AGENT_GITCONFIG_INCLUDE.replace(/^~\//, "")));

// With agents acting as the bot, Git answers "Repository not found" for a repo the bot was never
// invited to, the same as for a wrong address. When this shell's Git goes out as the bot and the repo
// is on github.com, it is read once as you (GH_CONFIG_DIR cleared; read-only): you seeing it means
// the bot is what lacks access. Null in every other case, so the caller keeps its general reason.
export async function explainBotRepoAccess({ cwd = process.cwd(), env = process.env, timeoutMs = DOCTOR_TIMEOUT_MS, read = githubClient.repository } = {}) {
  if (!includesAgentGitConfig((name) => env[name])) return null;
  const target = forgeTargetForRepositoryId(await currentRepositoryId(cwd));
  if (target?.host !== "github.com" || !target.repo) return null;
  try {
    await read({ cwd, timeoutMs, env: { GH_CONFIG_DIR: null } }, target.repo);
  } catch {
    return null;
  }
  return {
    message: `Agents act on GitHub as the bot account, and it cannot reach ${target.repo} yet, so nothing was set up.`,
    resolution: "Run `roborepo github setup` in this repo, in your own terminal; it invites the bot. Then run this again.",
  };
}

// Invites the bot to one repo as the user and accepts the invitation as the bot: the setup's invite
// steps, which need no typing, so the portal can run them. Only a repo admin can invite; anyone else
// gets `ok: false` and GitHub's reason, and the card's message for the owner says the rest.
export async function inviteBotToRepo({ repositoryId, cwd = process.cwd(), timeoutMs, botLogin }) {
  const target = forgeTargetForRepositoryId(repositoryId);
  if (target?.host !== "github.com" || !target.repo) return { ok: false, message: "This repo is not on github.com." };
  const repo = target.repo;
  const user = { cwd, timeoutMs, env: { GH_CONFIG_DIR: null } };
  const bot = { cwd, timeoutMs, env: botGhEnv(stateDir) };
  // The bot's own pending invitation is accepted first: it needs no admin rights, so a user who
  // cannot read the repo's invitations can still finish an invitation the owner already sent.
  const acceptPending = async () => {
    const pending = (await githubClient.userInvitations(bot)).find((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());
    if (pending) await githubClient.acceptInvitation(bot, pending.id);
    return !!pending;
  };
  try {
    if (await acceptPending()) return { ok: true };
    const permission = await githubClient.collaboratorPermission(user, repo, botLogin);
    // A Read collaborator cannot push either; the same request raises it to Write.
    if (permission === "read") await githubClient.inviteCollaborator(user, repo, botLogin);
    else if (permission !== "write" && permission !== "admin") {
      const invited = (await githubClient.repoInvitations(user, repo)).some((invitation) => invitation.invitee?.login?.toLowerCase() === botLogin.toLowerCase());
      if (!invited) await githubClient.inviteCollaborator(user, repo, botLogin);
      await acceptPending();
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    return { ok: false, message: `GitHub refused: ${error.message}. Only an admin of the repo can invite the bot.` };
  }
  return { ok: true };
}

// What this machine alone says about the bot account, read in a few milliseconds with no GitHub
// call: whether the package is on, which harnesses' agents still push as you, whether the Git
// settings file those harnesses include is in place, and what gh's hosts
// file names (signed in, token in the file, the saved login; never the token itself). The portal
// re-reads these on every request and reuses its GitHub reads only while they are unchanged.
// `credentials` is when and how large hosts.yml was last written: a token replaced for the same
// bot changes it, so a cached "expired" is not served for the new token. It is never the token.
export const readLocalAccountFacts = () => {
  const packageEnabled = agentIdentityPackageEnabled();
  return {
    packageEnabled,
    gitGaps: agentGitRoutingGaps(),
    gitconfigMissing: packageEnabled && agentGitconfigMissing(),
    hosts: readAgentHosts(stateDir),
    credentials: credentialRevision(),
  };
};

function credentialRevision() {
  try {
    const stat = fs.statSync(agentHostsFile(stateDir));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

// The bot account alone, and one repo for a known bot: the two halves the portal shows apart.
// `local` lets the portal pass the facts it already read, so the report matches what it cached on.
export const readCurrentAccountIdentity = ({ cwd = process.cwd(), timeoutMs, local = readLocalAccountFacts() } = {}) =>
  readAccountIdentity({ cwd, stateDir, timeoutMs, packageEnabled: local.packageEnabled, gitGaps: local.gitGaps, gitconfigMissing: local.gitconfigMissing });
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
      if (report.problems?.length > 0) {
        // The reason names the read that failed, which the findings found before it do not.
        const said = (part) => report.problems.some((entry) => entry.message.includes(part));
        const why = report.reason && !report.reason.split("; ").every(said) ? ` (${report.reason})` : "";
        return [`GitHub agent identity could not be fully checked${repo}${why}:`, ...problemLines(report.problems)].join("\n");
      }
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
