// `roborepo git <provider> status`: reads whether agents act on a forge provider (GitHub today) as a
// safe bot account. Every provider's status command calls this one module; its first argument is
// the provider id the command definition passes. The guided setup that fixes what this reports is
// `roborepo git <provider> setup` (forge-setup.mjs).
import fs from "node:fs";
import { ForgeError, forgeProviderById, hasForgeCapability, providerForRepositoryId } from "../../modules/forge/index.mjs";
import { readAccountIdentity, readAgentIdentity, readRepoAgentAccess } from "../../modules/forge/agent-identity.mjs";
import { setupCommand, statusCommand } from "../../modules/forge/agent-identity-findings.mjs";
import {
  agentGitconfigInclude, agentGitRoutingGaps, agentIdentityPackageEnabled, agentIdentityProviders, includesAgentGitConfig,
} from "./agent-identity-package.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { isMainModule } from "./roots.mjs";
import { stateDir } from "./state-paths.mjs";

// Doctor waits on these reads, so each gives up sooner than an explicit status command.
const DOCTOR_TIMEOUT_MS = 8000;

// The provider a command definition names, which must have an agent account.
export function agentIdentityProvider(id, options) {
  const provider = forgeProviderById(id, options);
  if (!hasForgeCapability(provider, "agent-identity")) throw new Error(`no forge provider with an agent account is named ${JSON.stringify(id)}`);
  return provider;
}

// The repo's provider when it has an agent account, else null.
export function repoAgentIdentityProvider(repositoryId, options) {
  const provider = providerForRepositoryId(repositoryId, options)?.provider;
  return hasForgeCapability(provider, "agent-identity") ? provider : null;
}

// What this machine alone says about one provider's package: whether it is on, which harnesses'
// agents still push as you, and whether the Git settings file those harnesses include is in place.
function packageFacts(provider) {
  const packageEnabled = agentIdentityPackageEnabled(provider);
  return { packageEnabled, gitGaps: agentGitRoutingGaps(provider), gitconfigMissing: packageEnabled && agentGitconfigMissing(provider) };
}

// `repositoryId` skips reading `cwd`'s origin when the caller already knows the repo (the portal).
export async function readCurrentAgentIdentity({ provider, cwd = process.cwd(), timeoutMs, repositoryId: known = null } = {}) {
  const repositoryId = known ?? await currentRepositoryId(cwd);
  return readAgentIdentity({ provider, repositoryId, cwd, stateDir, timeoutMs, ...packageFacts(provider) });
}

// Whether the Git settings file agents' Git includes is gone. Git skips a missing include without a
// word, so agents' pushes would go out as you.
const agentGitconfigMissing = (provider) => !fs.existsSync(agentGitconfigInclude(provider));

// With agents acting as a bot, Git answers "Repository not found" for a repo the bot was never
// invited to, the same as for a wrong address. When this shell's Git goes out as the repo's
// provider's bot, the repo is read once as you (the CLI's config folder cleared; read-only): you
// seeing it means the bot is what lacks access. Null in every other case, so the caller keeps its
// general reason. `read` replaces the provider's repository read (tests).
export async function explainBotRepoAccess({ cwd = process.cwd(), env = process.env, timeoutMs = DOCTOR_TIMEOUT_MS, read = null, providers } = {}) {
  const found = providerForRepositoryId(await currentRepositoryId(cwd), providers ? { providers } : {});
  const provider = found?.provider;
  if (!hasForgeCapability(provider, "agent-identity") || !found.repo) return null;
  if (!includesAgentGitConfig((name) => env[name], provider)) return null;
  const readRepository = read ?? provider.adapters.repository.repository;
  try {
    await readRepository({ cwd, timeoutMs, env: provider.adapters.agentIdentity.userEnv() }, found.repo);
  } catch {
    return null;
  }
  return {
    message: `Agents act on ${provider.manifest.displayName} as the bot account, and it cannot reach ${found.repo} yet, so nothing was set up.`,
    resolution: `Run \`${setupCommand(provider)}\` in this repo, in your own terminal; it invites the bot. Then run this again.`,
  };
}

// Invites the bot to one repo as the user and accepts the invitation as the bot: the setup's invite
// steps, which need no typing, so the portal can run them. Only a repo admin can invite; anyone else
// gets `ok: false` and the host's reason, and the card's message for the owner says the rest.
export async function inviteBotToRepo({ repositoryId, cwd = process.cwd(), timeoutMs, botLogin, providers }) {
  const found = providerForRepositoryId(repositoryId, providers ? { providers } : {});
  const provider = found?.provider;
  if (!hasForgeCapability(provider, "agent-identity") || !found.repo) {
    return { ok: false, message: `This repo is not on ${agentIdentityProviders({ providers }).flatMap((entry) => entry.manifest.hosts).join(" or ")}.` };
  }
  const adapter = provider.adapters.agentIdentity;
  const user = { cwd, timeoutMs, env: adapter.userEnv() };
  const bot = { cwd, timeoutMs, env: adapter.agentEnv(stateDir) };
  try {
    // The bot's own pending invitation is accepted first: it needs no admin rights, so a user who
    // cannot read the repo's invitations can still finish an invitation the owner already sent.
    if (await adapter.acceptInvitation(bot, found.repo)) return { ok: true };
    const { outcome } = await adapter.invite(user, found.repo, botLogin);
    if (outcome === "invited" || outcome === "pending") await adapter.acceptInvitation(bot, found.repo);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    return { ok: false, message: `${provider.manifest.displayName} refused: ${error.message}. Only an admin of the repo can invite the bot.` };
  }
  return { ok: true };
}

// What this machine alone says about the bot account, read in a few milliseconds with no host
// call: whether the package is on, which harnesses' agents still push as you, whether the Git
// settings file those harnesses include is in place, and what the stored login says (signed in,
// token in the file, the saved login; never the token itself). The portal re-reads these on every
// request and reuses its host reads only while they are unchanged. `credentials` is when and how
// large the credentials file was last written: a token replaced for the same bot changes it, so a
// cached "expired" is not served for the new token. It is never the token.
export const readLocalAccountFacts = (provider) => ({
  ...packageFacts(provider),
  hosts: provider.adapters.agentIdentity.readStoredLogin(stateDir),
  credentials: credentialRevision(provider),
});

function credentialRevision(provider) {
  try {
    const stat = fs.statSync(provider.adapters.agentIdentity.credentialsFile(stateDir));
    return `${stat.mtimeMs}:${stat.size}`;
  } catch {
    return null;
  }
}

// The bot account alone, and one repo for a known bot: the two halves the portal shows apart.
// `local` lets the portal pass the facts it already read, so the report matches what it cached on.
export const readCurrentAccountIdentity = ({ provider, cwd = process.cwd(), timeoutMs, local = readLocalAccountFacts(provider) }) =>
  readAccountIdentity({ provider, cwd, stateDir, timeoutMs, packageEnabled: local.packageEnabled, gitGaps: local.gitGaps, gitconfigMissing: local.gitconfigMissing });
export const readCurrentRepoAgentAccess = ({ provider, repositoryId, cwd = process.cwd(), timeoutMs, botLogin }) =>
  readRepoAgentAccess({ provider, repositoryId, cwd, stateDir, timeoutMs, botLogin });

// The status command. `argv` starts with the provider id the command definition prepends.
export async function forgeStatusCommand([providerId, ...argv] = []) {
  const provider = agentIdentityProvider(providerId);
  const rest = argv.filter((arg) => arg !== "--json");
  if (rest.length > 0) {
    console.error(`Unknown option: ${rest[0]}\nUsage: ${statusCommand(provider)} [--json]`);
    process.exitCode = 2;
    return;
  }
  const report = await readCurrentAgentIdentity({ provider });
  if (argv.includes("--json")) console.log(JSON.stringify(report, null, 2));
  else console.log(formatReport(report, provider));
  process.exitCode = report.state === "problem" ? 1 : 0;
}

export function formatReport(report, provider) {
  const name = `${provider.manifest.displayName} agent identity`;
  const repo = report.repository ? ` for ${report.repository}` : "";
  switch (report.state) {
    case "not-set-up":
      return `${name} is not set up (optional). Run ${setupCommand(provider)} in your own terminal to let agents act on ${provider.manifest.displayName} as a bot account.`;
    case "unavailable":
      if (report.problems?.length > 0) {
        // The reason names the read that failed, which the findings found before it do not.
        const said = (part) => report.problems.some((entry) => entry.message.includes(part));
        const why = report.reason && !report.reason.split("; ").every(said) ? ` (${report.reason})` : "";
        return [`${name} could not be fully checked${repo}${why}:`, ...problemLines(report.problems)].join("\n");
      }
      return `${name} could not be checked${repo}: ${report.reason}. Nothing is wrong that this check can see.`;
    default: {
      const headline = report.state === "healthy"
        ? `${name} is healthy${repo}: agents act as ${report.botLogin}.`
        : report.state === "unverified"
          ? `${name}${repo}: agents act as ${report.botLogin}, but the branch rules could not be verified:`
          : `${name} has problems${repo}:`;
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
// A report with no repository (a provider whose package is on but that does not serve this repo)
// describes the account alone.
export function doctorLine(report, provider) {
  const name = `${provider.manifest.displayName} agent identity`;
  const repo = report.repository;
  const forRepo = repo ? ` for ${repo}` : "";
  switch (report.state) {
    case "not-set-up":
      return { level: "ok", text: `${name} not set up (optional) — run ${setupCommand(provider)} in your own terminal` };
    case "healthy": {
      const warn = report.problems[0];
      if (warn) return { level: "hint", text: `${name}${forRepo}: ${warn.message} — ${fixClause(warn.fix)}` };
      return { level: "ok", text: `${name}: agents act as ${report.botLogin}${repo ? ` on ${repo}` : ""}` };
    }
    case "unverified": {
      const first = report.problems.find((entry) => entry.severity === "unverified");
      return { level: "hint", text: `${name}${forRepo}: ${first.message} — ${fixClause(first.fix)}` };
    }
    case "problem": {
      const first = report.problems.find((entry) => entry.severity === "problem");
      return { level: "hint", text: `${name} problem${forRepo}: ${first.message} — ${fixClause(first.fix)}` };
    }
    default: {
      // A check that could not run is something you can act on; the host being unreachable is not.
      const unchecked = report.problems?.find((entry) => entry.severity === "unchecked");
      if (unchecked) return { level: "hint", text: `${name}${forRepo} not fully checked: ${unchecked.message} — ${fixClause(unchecked.fix)}` };
      return { level: "ok", text: `${name} check skipped (${report.reason})` };
    }
  }
}

// Doctor's lines: one per provider with an agent account that serves the current repo, whether its
// package is on or not (not set up is an `ok` line). A repo has one host, so today that is at most
// one line; a provider whose package is on elsewhere has no repo here to check, and adds nothing.
// The level of the whole check is the worst line's.
export async function doctorLines({ cwd = process.cwd(), timeoutMs = DOCTOR_TIMEOUT_MS, providers } = {}) {
  const repositoryId = await currentRepositoryId(cwd);
  const lines = [];
  for (const provider of agentIdentityProviders({ providers })) {
    if (repoAgentIdentityProvider(repositoryId, { providers: [provider] }) !== provider) continue;
    lines.push(doctorLine(await readCurrentAgentIdentity({ provider, cwd, timeoutMs, repositoryId }), provider));
  }
  return lines;
}

// --doctor is scripts/doctor.sh's contract, as in protect.mjs: one line per provider, exit 0 when
// every line is `ok` and 1 when any is a `hint`; nothing, exit 0, when no provider serves this repo
// (outside a Git repo, or on a host with no agent account); exit 3 on a crash.
async function doctorMode() {
  try {
    const lines = await doctorLines();
    for (const { text } of lines) console.log(text);
    return lines.some((line) => line.level === "hint") ? 1 : 0;
  } catch (error) {
    console.log(String(error?.message || error));
    return 3;
  }
}

if (isMainModule(import.meta.url)) {
  if (!process.argv.includes("--doctor")) {
    console.error("usage: node forge-identity.mjs --doctor");
    process.exit(2);
  }
  process.exit(await doctorMode());
}
