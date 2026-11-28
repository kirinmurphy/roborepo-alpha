// Whether agents in a repo can act as the bot account of the repo's forge provider safely: the bot
// is signed in with a token stored where agent sandboxes can read it, it is a different person from
// the user, it can push but not administer the repo, its token is not broader than it needs, and the
// repo's branches are protected. This is the generic half: states, findings, and their order. What
// only one host knows (its token, its CLI, its invitations) comes from the provider's
// `agent-identity` adapter. It only reads; the guided setup (scripts/cli/forge-setup.mjs) makes
// every change.
import { ForgeError } from "./errors.mjs";
import { forgeTargetForRepositoryId } from "./repository-id.mjs";
import { readProtection } from "./protection.mjs";
import { askOwner, enableCommand, finding as problem, setupCommand, setupFix, statusCommand } from "./agent-identity-findings.mjs";

export { EXPIRING_DAYS } from "./agent-identity-findings.mjs";

const servesRepo = (provider, target) => Boolean(target && provider.manifest.hosts.includes(target.host));

// The bot account, read once for every repo: whether it is signed in, whether the host takes its
// token, the token's expiry and scopes, whether it is a different account from yours, and whether
// the package is on. `state` is `not-set-up`, `healthy`, `problem`, or `unavailable`. `botLogin` is
// the login the host confirms for the token; `savedLogin` is the one stored with it, which survives
// an expired token. `packageEnabled` is passed in by the caller, which knows the package state, and
// so is `gitGaps`: the harnesses whose agents' Git does not yet include the bot's settings, and
// `gitconfigMissing`: the package is on but the Git settings file those harnesses include is gone.
export async function readAccountIdentity({ provider, cwd = process.cwd(), stateDir, timeoutMs, packageEnabled = false, gitGaps = [], gitconfigMissing = false }) {
  const adapter = provider.adapters.agentIdentity;
  const { displayName } = provider.manifest;
  const hosts = adapter.readStoredLogin(stateDir);
  const result = {
    state: "not-set-up", botLogin: null, savedLogin: hosts.user, userLogin: null, signedIn: hosts.loggedIn, packageEnabled,
    expiresAt: null, scopes: null, problems: [], reason: null,
  };
  const packageState = (problems) => withPackageState(provider, problems, packageEnabled, gitGaps, gitconfigMissing);
  if (!hosts.loggedIn) {
    if (!packageEnabled) return result;
    return finish(result, [problem("bot-missing", "The package is on but no bot account is signed in.", setupFix(provider))]);
  }

  const problems = [];
  const bot = { cwd, timeoutMs, env: adapter.agentEnv(stateDir) };
  const user = { cwd, timeoutMs, env: adapter.userEnv() };
  try {
    problems.push(...adapter.localFileProblems(stateDir, hosts));
    let info;
    try {
      info = await adapter.readAccount(bot);
    } catch (error) {
      if (error instanceof ForgeError && error.status === 401) {
        problems.push(problem("expired", `${displayName} rejected the bot's token (it expired or was revoked).`, setupFix(provider)));
        return finish(result, packageState(problems));
      }
      throw error;
    }
    result.botLogin = info.login;
    result.scopes = info.scopes;
    result.expiresAt = info.expiresAt ? info.expiresAt.toISOString() : null;
    problems.push(...adapter.accountProblems(info));

    result.userLogin = await adapter.readLogin(user).catch(() => null);
    if (!result.userLogin) {
      problems.push(problem("account-unchecked", `Your own ${displayName} sign-in could not be read, so this could not confirm the bot is a different account.`, `Run ${adapter.userSignInCheck} in your own terminal, then rerun ${statusCommand(provider)}.`, "unchecked"));
    } else if (result.userLogin.toLowerCase() === info.login.toLowerCase()) {
      problems.push(problem("bot-is-user", `The bot account ${info.login} is your own account, so agents would have your access.`, setupFix(provider)));
    }
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    // A problem already found stays reported: a later read failing does not make it go away.
    if (problems.some((entry) => entry.severity === "problem")) {
      return finish(result, [...packageState(problems), incomplete(provider, error)]);
    }
    return { ...result, problems: packageState(problems), state: "unavailable", reason: error.message };
  }
  return finish(result, packageState(problems));
}

// The package-off finding goes last, after what the bot account itself lacks, and names the
// shortest step that works: with nothing else in the way, turning the package on is all that is
// left of the setup; otherwise the setup fixes the rest and turns it on at the end.
//
// With the package on, the Git gap goes last instead: a broken token matters more than pushes that
// still go out as the user, and is the finding shown first.
function withPackageState(provider, problems, packageEnabled, gitGaps = [], gitconfigMissing = false) {
  const { packageId } = provider.manifest.agent;
  if (packageEnabled) {
    if (gitconfigMissing) {
      // Git skips an include whose file is missing, so the harness settings alone prove nothing.
      return [...problems, problem(
        "git-config-missing",
        `Agents' git pushes still go out as you, because the Git settings file the ${packageId} package installs is missing.`,
        `Run ${setupCommand(provider)} in your own terminal; it installs the package again.`,
      )];
    }
    if (gitGaps.length === 0) return problems;
    return [...problems, problem(
      "git-not-routed",
      // What happens, then why, briefly: the settings come from an install older than this check.
      "Agents' git pushes still go out as you, because your harness settings don't include the bot's Git settings yet.",
      "Run roborepo update, then start new agent sessions.",
    )];
  }
  const setupOnly = provider.adapters.agentIdentity.setupOnlyWarnings;
  const blocked = problems.some((entry) => entry.severity !== "warn" || setupOnly.has(entry.id));
  return [...problems, problem(
    "package-off",
    `The bot is signed in, but the ${packageId} package is off, so agents still act as you.`,
    blocked ? `Run ${setupCommand(provider)} in your own terminal; it fixes the above and turns the package on.` : `Turn it on: ${enableCommand(provider)}.`,
  )];
}

// Whether turning the package on is the only step left: the bot works and nothing but the package
// (or advice such as an expiry note) is reported.
export function packageIsOnlyStep(provider, account) {
  const setupOnly = provider.adapters.agentIdentity.setupOnlyWarnings;
  const offending = account.problems.filter((entry) => entry.id !== "package-off");
  return !account.packageEnabled && account.signedIn && Boolean(account.botLogin)
    && account.state !== "unavailable"
    && offending.every((entry) => entry.severity === "warn" && !setupOnly.has(entry.id));
}

// One repo, for a bot account that works: whether the bot can push there, and whether the host's
// branch rules stop it from merging unreviewed work. `userAdmin` says whether you administer the
// repo, which decides who can fix a finding: you (setup, `roborepo protect`) or the repo's owner,
// who gets `ownerMessage`. `state` is `healthy`, `unverified` (the rules apply but you cannot see who
// may bypass them), `problem`, or `unavailable`.
export async function readRepoAgentAccess({ provider, repositoryId, cwd = process.cwd(), stateDir, timeoutMs, botLogin }) {
  const adapter = provider.adapters.agentIdentity;
  const result = {
    state: "healthy", repository: null, botLogin, userAdmin: null, defaultBranch: null, problems: [], reason: null, ownerMessage: null,
  };
  const target = forgeTargetForRepositoryId(repositoryId);
  if (!servesRepo(provider, target)) return { ...result, state: "unavailable", reason: `this repo has no ${provider.manifest.displayName} remote` };
  result.repository = target.repo;
  const problems = [];
  try {
    // Read as you, so `admin` says whether you administer the repo.
    const protection = await readProtection({ repositoryId, cwd, timeoutMs, env: adapter.userEnv() });
    const readable = !["unavailable", "unsupported"].includes(protection.state);
    result.userAdmin = readable ? protection.admin === true : null;
    result.defaultBranch = protection.defaultBranch || null;
    try {
      const bot = { cwd, timeoutMs, env: adapter.agentEnv(stateDir) };
      problems.push(...await adapter.readRepoAccess(bot, target.repo, botLogin, { userAdmin: result.userAdmin }));
    } catch (error) {
      // The protection was already read: what it found stays reported when the bot's read fails.
      if (error instanceof ForgeError) checkProtection(provider, protection, problems, result.userAdmin);
      throw error;
    }
    checkProtection(provider, protection, problems, result.userAdmin);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    if (problems.some((entry) => entry.severity === "problem")) return finishRepo(provider, result, [...problems, incomplete(provider, error)]);
    return { ...result, problems, state: "unavailable", reason: error.message };
  }
  return finishRepo(provider, result, problems);
}

// Both reads for one repo, as the status command and doctor report them: the account's findings,
// then the repo's. The repo is read only when the bot's token works. `provider` is the repo's.
export async function readAgentIdentity({ provider, repositoryId, cwd = process.cwd(), stateDir, timeoutMs, packageEnabled = false, gitGaps = [], gitconfigMissing = false }) {
  const target = forgeTargetForRepositoryId(repositoryId);
  const base = { repository: null, ownerMessage: null, userAdmin: null };
  if (!servesRepo(provider, target)) {
    return {
      ...base, state: "unavailable", botLogin: null, userLogin: null, packageEnabled, expiresAt: null, scopes: null, problems: [],
      reason: `this repo has no ${provider.manifest.displayName} remote`,
    };
  }
  base.repository = target.repo;
  const account = await readAccountIdentity({ provider, cwd, stateDir, timeoutMs, packageEnabled, gitGaps, gitconfigMissing });
  const merged = { ...account, ...base };
  if (account.state === "not-set-up" || !account.botLogin) return merged;
  // Your own sign-in failing to read is already an unchecked finding; the host not answering at all
  // means the repo reads would fail the same way.
  if (account.state === "unavailable" && account.problems.length === 0) return merged;
  const repo = await readRepoAgentAccess({ provider, repositoryId, cwd, stateDir, timeoutMs, botLogin: account.botLogin });
  const problems = [...account.problems, ...repo.problems];
  const combined = { ...merged, userAdmin: repo.userAdmin, ownerMessage: repo.ownerMessage };
  // A repo read that stopped early (it may still carry what it found first, such as unverified
  // protection) keeps a known problem a problem and says some checks could not run: the failed read
  // is an unchecked finding, so rules found unverified never stand in for it.
  if (repo.state === "unavailable" && repo.reason) {
    if (repo.problems.length === 0 && !problems.some((entry) => entry.severity === "problem")) {
      return { ...combined, problems, state: "unavailable", reason: repo.reason };
    }
    return finish(combined, [...problems, incomplete(provider, { message: repo.reason })]);
  }
  return finish(combined, problems);
}

const incomplete = (provider, error) => problem("check-incomplete", `Some checks could not run: ${error.message}.`, `Rerun ${statusCommand(provider)} once ${provider.manifest.displayName} answers.`, "unchecked");

function finish(result, problems) {
  if (problems.some((entry) => entry.severity === "problem")) return { ...result, problems, state: "problem" };
  const unchecked = problems.filter((entry) => entry.severity === "unchecked");
  if (unchecked.length > 0) {
    return { ...result, problems, state: "unavailable", reason: unchecked.map((entry) => entry.message.replace(/\.$/, "")).join("; ") };
  }
  if (problems.some((entry) => entry.severity === "unverified")) return { ...result, problems, state: "unverified" };
  return { ...result, problems, state: "healthy" };
}

function finishRepo(provider, result, problems) {
  const done = finish(result, problems);
  const ownerFixes = problems.filter((entry) => entry.owner);
  if (result.userAdmin !== false || ownerFixes.length === 0 || !result.botLogin) return done;
  return {
    ...done,
    ownerMessage: provider.adapters.agentIdentity.ownerMessage({
      repo: result.repository, botLogin: result.botLogin,
      invite: ownerFixes.some((entry) => entry.id === "not-collaborator"),
      protections: ownerFixes.some((entry) => entry.id === "protection" || entry.id === "protection-unverified"),
    }),
  };
}

// Whether the host stops the bot from merging unreviewed work in this repo, from the protection
// report read as you. Rules that apply but whose bypass list you cannot see (you are not an admin)
// are `unverified`, never healthy: the owner could let the bot bypass them.
function checkProtection(provider, report, problems, userAdmin) {
  const host = provider.manifest.displayName;
  if (report.state === "unavailable") {
    problems.push(problem("protection-unchecked", `Branch protection could not be read${report.reason ? ` (${report.reason})` : ""}, so this could not confirm ${host} stops the bot from merging unreviewed work.`, "Run roborepo protect --check in your own terminal.", "unchecked"));
    return;
  }
  const skipped = report.policies?.some((policy) => policy.status === "skipped");
  const applies = (report.state === "protected" || report.state === "unmanaged") && !skipped;
  if (applies && report.admin && report.bypassVerified) return;
  if (applies && report.admin) {
    // An admin of the repo still cannot read an organization ruleset's bypass list.
    problems.push(problem("protection-unverified", `${host} applies the branch rules, but some come from an organization ruleset whose bypass list RoboRepo cannot read, so it cannot confirm the bot cannot bypass them.`, "Ask an organization owner to confirm the bot cannot bypass them, or run roborepo protect to add the repo's own rules.", "unverified"));
    return;
  }
  if (applies) {
    problems.push({
      ...problem("protection-unverified", `${host} applies the branch rules, but you are not an admin of this repo, so RoboRepo cannot see who may bypass them.`, askOwner("confirm them, and that the bot cannot bypass them"), "unverified"),
      owner: true,
    });
    return;
  }
  const message = skipped
    ? "The merge rule that requires approval of the last push is skipped for this repo."
    : `Branch protection for this repo is ${report.state}, so ${host} does not stop the bot from merging unreviewed work.`;
  if (userAdmin === false) {
    problems.push({ ...problem("protection", message, askOwner("add the branch rules")), owner: true });
  } else if (userAdmin === true) {
    problems.push(problem("protection", message, "Run roborepo protect in this repo (it asks before changing anything), or open Branch protection in the repo's menu on Home."));
  } else {
    problems.push(problem("protection", message, "A repo admin should run roborepo protect (it asks before changing anything)."));
  }
}
