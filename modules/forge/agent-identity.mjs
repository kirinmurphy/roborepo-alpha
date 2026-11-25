// Whether agents in a GitHub repo can act as the bot account safely: the bot is signed in with a
// token stored where agent sandboxes can read it, it is a different person from the user, it can
// push but not administer the repo, its token is not broader than it needs, and the repo's
// branches are protected. It only reads, except `refreshCaBundle`, which writes the CA bundle copy;
// the guided setup in scripts/cli/github-setup.mjs makes every other change.
import fs from "node:fs";
import path from "node:path";
import { GitHubError, forgeTargetForRepositoryId } from "./index.mjs";
import { githubClient } from "./github.mjs";
import { MANUAL_STEPS, readProtection } from "./protection.mjs";

export const AGENT_IDENTITY_PACKAGE_ID = "github-agent-identity";
// How early status and doctor start warning that the bot's token is about to expire. Two weeks
// leaves room to notice the note between doctor runs.
export const EXPIRING_DAYS = 14;
const REQUIRED_SCOPES = ["repo", "read:org"];
const SETUP_FIX = "Run roborepo github setup in your own terminal.";

export const agentGhConfigDir = (stateDir) => path.join(stateDir, "github-agent", "gh");

// The environment for a gh call made as the bot. GH_TOKEN and GITHUB_TOKEN take precedence over
// the stored login, so a token the user exported would make the call run as the user; null removes
// them (runGh deletes null entries). `dir` defaults to the bot's config directory; setup passes a
// staging directory to try a new token before it replaces the live one.
export const botGhEnv = (stateDir, dir = agentGhConfigDir(stateDir)) => ({ GH_CONFIG_DIR: dir, GH_TOKEN: null, GITHUB_TOKEN: null });
export const agentCaBundleFile = (stateDir) => path.join(stateDir, "github-agent", "ca-bundle.crt");
export const agentCaGitconfigFile = (stateDir) => path.join(stateDir, "github-agent", "gitconfig.local");

// Where the system's CA bundle usually lives. ROBOREPO_SYSTEM_CA_BUNDLE replaces the list with one
// path, so tests can point at a fixture instead of the machine's real bundle.
const CA_BUNDLE_CANDIDATES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

export function findSystemCaBundle() {
  const override = process.env.ROBOREPO_SYSTEM_CA_BUNDLE;
  return (override ? [override] : CA_BUNDLE_CANDIDATES).find((file) => fs.existsSync(file)) || null;
}

function writeIfChanged(file, content, mode) {
  try {
    if (Buffer.compare(fs.readFileSync(file), Buffer.from(content)) === 0) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content, { mode });
  fs.chmodSync(file, mode);
  return true;
}

// Codex's sandbox denies *.pem files, so Git and curl cannot read the system CA bundle there. Setup
// copies it under a name the sandbox allows and points Git at the copy for github.com through a
// gitconfig the package's gitconfig includes. Returns `{ copied, changed }`; `copied: false` means
// the system has no bundle file (Windows, where Git uses the OS store), and any old copy is removed.
export function refreshCaBundle({ stateDir }) {
  const source = findSystemCaBundle();
  const copy = agentCaBundleFile(stateDir);
  const local = agentCaGitconfigFile(stateDir);
  if (!source) {
    let changed = false;
    for (const file of [local, copy]) {
      if (fs.existsSync(file)) { fs.rmSync(file); changed = true; }
    }
    return { copied: false, changed };
  }
  const changedCopy = writeIfChanged(copy, fs.readFileSync(source), 0o644);
  const changedConfig = writeIfChanged(local, caGitconfig(copy), 0o644);
  return { copied: true, changed: changedCopy || changedConfig };
}

const caGitconfig = (copy) => `# Codex's sandbox denies *.pem files, so Git reads a copy of the system CA bundle.\n[http "https://github.com/"]\n\tsslCAInfo = ${copy}\n`;

// Stale when the copy differs from the system bundle, or when the Git config that points Git at the
// copy is missing or says something else: a setup stopped between the two writes leaves a matching
// copy that Git never reads.
function caBundleStale(stateDir) {
  const source = findSystemCaBundle();
  if (!source) return false;
  try {
    if (Buffer.compare(fs.readFileSync(source), fs.readFileSync(agentCaBundleFile(stateDir))) !== 0) return true;
    return fs.readFileSync(agentCaGitconfigFile(stateDir), "utf8") !== caGitconfig(agentCaBundleFile(stateDir));
  } catch {
    return true;
  }
}

export const agentHostsFile = (stateDir) => path.join(agentGhConfigDir(stateDir), "hosts.yml");

// What the bot's hosts.yml says, without ever returning the token: `loggedIn` when it has a
// github.com entry, `hasToken` when that entry holds a non-empty oauth_token (the token is in the
// file rather than the keychain), and `user`, the login gh saved with it (null when absent). The
// saved login names the bot even after GitHub stops accepting its token, which is what lets setup
// renew a token without asking which account the bot is. The file is read as the small indented
// YAML gh writes.
export function readAgentHosts(stateDir) {
  let text;
  try {
    text = fs.readFileSync(agentHostsFile(stateDir), "utf8");
  } catch {
    return { loggedIn: false, hasToken: false, user: null };
  }
  let inEntry = false;
  let loggedIn = false;
  let hasToken = false;
  let user = null;
  const value = (raw) => raw.trim().replace(/^["']|["']$/g, "");
  for (const line of text.split(/\r?\n/)) {
    if (/^\S/.test(line)) {
      inEntry = /^["']?github\.com["']?\s*:/.test(line);
      if (inEntry) loggedIn = true;
    } else if (inEntry) {
      const token = /^\s+oauth_token\s*:\s*(.*)$/.exec(line);
      if (token && value(token[1]) !== "") hasToken = true;
      // Only the entry's own `user:` line, at the indent of oauth_token, not one nested under `users:`.
      const named = /^ {4}user\s*:\s*(.*)$/.exec(line);
      if (named && value(named[1]) !== "") user = value(named[1]);
    }
  }
  return { loggedIn, hasToken, user };
}

// The command that turns the identity on once the bot account is ready; it is all a person needs
// when the package is the only thing missing.
export const ENABLE_COMMAND = `roborepo package enable ${AGENT_IDENTITY_PACKAGE_ID}`;

// The bot account, read once for every repo: whether it is signed in, whether GitHub takes its
// token, the token's expiry and scopes, whether it is a different account from yours, and whether
// the package is on. `state` is `not-set-up`, `healthy`, `problem`, or `unavailable`. `botLogin` is
// the login GitHub confirms for the token; `savedLogin` is the one hosts.yml names, which survives
// an expired token. `packageEnabled` is passed in by the caller, which knows the package state, and
// so is `gitGaps`: the harnesses whose agents' Git does not yet include the bot's settings.
export async function readAccountIdentity({ cwd = process.cwd(), stateDir, timeoutMs, packageEnabled = false, gitGaps = [] }) {
  const hosts = readAgentHosts(stateDir);
  const result = {
    state: "not-set-up", botLogin: null, savedLogin: hosts.user, userLogin: null, signedIn: hosts.loggedIn, packageEnabled,
    expiresAt: null, scopes: null, problems: [], reason: null,
  };
  if (!hosts.loggedIn) {
    if (!packageEnabled) return result;
    return finish(result, [problem("bot-missing", "The package is on but no bot account is signed in.", SETUP_FIX)]);
  }

  const problems = [];
  const bot = { cwd, timeoutMs, env: botGhEnv(stateDir) };
  // Your own account, even from a shell that points GH_CONFIG_DIR at the bot.
  const user = { cwd, timeoutMs, env: { GH_CONFIG_DIR: null } };
  try {
    if (!hosts.hasToken) {
      problems.push(problem("token-in-keychain", "The bot's token is in the keychain, which agent sandboxes cannot read.", SETUP_FIX));
    }
    if (caBundleStale(stateDir)) {
      problems.push(problem("ca-bundle-stale", "The certificate bundle copy Codex's sandbox uses for Git is missing or out of date.", "Run roborepo github setup to refresh it.", "warn"));
    }
    let info;
    try {
      info = await githubClient.tokenInfo(bot);
    } catch (error) {
      if (error instanceof GitHubError && error.status === 401) {
        problems.push(problem("expired", "GitHub rejected the bot's token (it expired or was revoked).", SETUP_FIX));
        return finish(result, withPackageState(problems, packageEnabled, gitGaps));
      }
      throw error;
    }
    result.botLogin = info.login;
    result.scopes = info.scopes;
    result.expiresAt = info.expiresAt ? info.expiresAt.toISOString() : null;
    problems.push(...tokenProblems(info));

    result.userLogin = await githubClient.login(user).catch(() => null);
    if (!result.userLogin) {
      problems.push(problem("account-unchecked", "Your own GitHub sign-in could not be read, so this could not confirm the bot is a different account.", "Run gh auth status in your own terminal, then rerun roborepo github status.", "unchecked"));
    } else if (result.userLogin.toLowerCase() === info.login.toLowerCase()) {
      problems.push(problem("bot-is-user", `The bot account ${info.login} is your own account, so agents would have your access.`, SETUP_FIX));
    }
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // A problem already found stays reported: a later read failing does not make it go away.
    if (problems.some((entry) => entry.severity === "problem")) {
      return finish(result, [...withPackageState(problems, packageEnabled, gitGaps), incomplete(error)]);
    }
    return { ...result, problems: withPackageState(problems, packageEnabled, gitGaps), state: "unavailable", reason: error.message };
  }
  return finish(result, withPackageState(problems, packageEnabled, gitGaps));
}

// The package-off finding goes last, after what the bot account itself lacks, and names the
// shortest step that works: with nothing else in the way, turning the package on is all that is
// left of the setup; otherwise the setup fixes the rest and turns it on at the end.
//
// With the package on, the Git gap goes last instead: a broken token matters more than pushes that
// still go out as the user, and is the finding shown first.
function withPackageState(problems, packageEnabled, gitGaps = []) {
  if (packageEnabled) {
    if (gitGaps.length === 0) return problems;
    return [...problems, problem(
      "git-not-routed",
      // What happens, then why, briefly: the settings come from an install older than this check.
      "Agents' git pushes still go out as you, because your harness settings don't include the bot's Git settings yet.",
      "Run roborepo update, then start new agent sessions.",
    )];
  }
  const blocked = problems.some((entry) => entry.severity !== "warn" || entry.id === "ca-bundle-stale");
  return [...problems, problem(
    "package-off",
    "The bot is signed in, but the github-agent-identity package is off, so agents still act as you.",
    blocked ? "Run roborepo github setup in your own terminal; it fixes the above and turns the package on." : `Turn it on: ${ENABLE_COMMAND}.`,
  )];
}

// Whether turning the package on is the only step left: the bot works and nothing but the package
// (or advice such as an expiry note) is reported.
export function packageIsOnlyStep(account) {
  const offending = account.problems.filter((entry) => entry.id !== "package-off");
  return !account.packageEnabled && account.signedIn && Boolean(account.botLogin)
    && account.state !== "unavailable"
    && offending.every((entry) => entry.severity === "warn" && entry.id !== "ca-bundle-stale");
}

// One repo, for a bot account that works: whether the bot can push there (invited, invitation
// pending, or admin, which is too much), and whether GitHub's branch rules stop it from merging
// unreviewed work. `userAdmin` says whether you administer the repo, which decides who can fix a
// finding: you (setup, `roborepo protect`) or the repo's owner, who gets `ownerMessage`. `state` is
// `healthy`, `unverified` (the rules apply but you cannot see who may bypass them), `problem`, or
// `unavailable`.
export async function readRepoAgentAccess({ repositoryId, cwd = process.cwd(), stateDir, timeoutMs, botLogin }) {
  const result = {
    state: "healthy", repository: null, botLogin, userAdmin: null, defaultBranch: null, problems: [], reason: null, ownerMessage: null,
  };
  const target = forgeTargetForRepositoryId(repositoryId);
  if (!target || target.host !== "github.com") return { ...result, state: "unavailable", reason: "this repo has no GitHub remote" };
  result.repository = target.repo;
  const problems = [];
  try {
    // Read as you, so `admin` says whether you administer the repo.
    const protection = await readProtection({ repositoryId, cwd, timeoutMs, env: { GH_CONFIG_DIR: null } });
    const readable = !["unavailable", "unsupported"].includes(protection.state);
    result.userAdmin = readable ? protection.admin === true : null;
    result.defaultBranch = protection.defaultBranch || null;
    await checkRepoAccess({ cwd, timeoutMs, env: botGhEnv(stateDir) }, target.repo, botLogin, problems, result.userAdmin);
    checkProtection(protection, problems, result.userAdmin);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    if (problems.some((entry) => entry.severity === "problem")) return finishRepo(result, [...problems, incomplete(error)]);
    return { ...result, problems, state: "unavailable", reason: error.message };
  }
  return finishRepo(result, problems);
}

// Both reads for one repo, as `roborepo github status` and doctor report them: the account's
// findings, then the repo's. The repo is read only when the bot's token works.
export async function readAgentIdentity({ repositoryId, cwd = process.cwd(), stateDir, timeoutMs, packageEnabled = false, gitGaps = [] }) {
  const target = forgeTargetForRepositoryId(repositoryId);
  const base = { repository: null, ownerMessage: null, userAdmin: null };
  if (!target || target.host !== "github.com") {
    return {
      ...base, state: "unavailable", botLogin: null, userLogin: null, packageEnabled, expiresAt: null, scopes: null, problems: [],
      reason: "this repo has no GitHub remote",
    };
  }
  base.repository = target.repo;
  const account = await readAccountIdentity({ cwd, stateDir, timeoutMs, packageEnabled, gitGaps });
  const merged = { ...account, ...base };
  if (account.state === "not-set-up" || !account.botLogin) return merged;
  // Your own sign-in failing to read is already an unchecked finding; GitHub not answering at all
  // means the repo reads would fail the same way.
  if (account.state === "unavailable" && account.problems.length === 0) return merged;
  const repo = await readRepoAgentAccess({ repositoryId, cwd, stateDir, timeoutMs, botLogin: account.botLogin });
  const problems = [...account.problems, ...repo.problems];
  const combined = { ...merged, userAdmin: repo.userAdmin, ownerMessage: repo.ownerMessage };
  if (repo.state === "unavailable" && repo.problems.length === 0) {
    if (problems.some((entry) => entry.severity === "problem")) return finish(combined, [...problems, incomplete({ message: repo.reason })]);
    return { ...combined, problems, state: "unavailable", reason: repo.reason };
  }
  return finish(combined, problems);
}

// What is wrong with a token by itself, from `githubClient.tokenInfo`: its expiry and its scopes.
// Setup uses it to judge a new token before installing it, and to offer replacing one that works
// but is expiring, has no expiry date, or has the wrong scopes.
export function tokenProblems(info) {
  const problems = [];
  checkExpiry(info.expiresAt, problems);
  checkScopes(info.scopes, problems);
  return problems;
}

// A message you can send the owner of a repo you do not administer, asking for what the bot needs
// there: an invitation with write access, and the branch rules RoboRepo would otherwise create.
export function ownerMessage({ repo, botLogin, invite = true, protections = true }) {
  const asks = [];
  if (invite) asks.push(`Invite ${botLogin} to ${repo} as a collaborator with Write access (not Admin).`);
  if (protections) {
    asks.push("Make sure these branch rules are in place (rulesets, under Settings > Rules):");
    for (const step of MANUAL_STEPS) asks.push(`   - ${step}`);
  }
  const numbered = [];
  let n = 0;
  for (const line of asks) numbered.push(line.startsWith("   -") ? line : `${++n}. ${line}`);
  return [
    `Hi! My coding agents work on GitHub as a separate bot account, ${botLogin}, instead of as me, so GitHub itself stops them from pushing to the default branch or merging without a human approval. Could you help set that up on ${repo}?`,
    "",
    ...numbered,
    "",
    `${botLogin} never needs Admin, and it should not be able to bypass these rules. Thanks!`,
  ].join("\n");
}

function problem(id, message, fix, severity = "problem") {
  return { id, message, fix, severity };
}

const incomplete = (error) => problem("check-incomplete", `Some checks could not run: ${error.message}.`, "Rerun roborepo github status once GitHub answers.", "unchecked");

function finish(result, problems) {
  if (problems.some((entry) => entry.severity === "problem")) return { ...result, problems, state: "problem" };
  const unchecked = problems.filter((entry) => entry.severity === "unchecked");
  if (unchecked.length > 0) {
    return { ...result, problems, state: "unavailable", reason: unchecked.map((entry) => entry.message.replace(/\.$/, "")).join("; ") };
  }
  if (problems.some((entry) => entry.severity === "unverified")) return { ...result, problems, state: "unverified" };
  return { ...result, problems, state: "healthy" };
}

function finishRepo(result, problems) {
  const done = finish(result, problems);
  const ownerFixes = problems.filter((entry) => entry.owner);
  if (result.userAdmin !== false || ownerFixes.length === 0 || !result.botLogin) return done;
  return {
    ...done,
    ownerMessage: ownerMessage({
      repo: result.repository, botLogin: result.botLogin,
      invite: ownerFixes.some((entry) => entry.id === "not-collaborator"),
      protections: ownerFixes.some((entry) => entry.id === "protection" || entry.id === "protection-unverified"),
    }),
  };
}

// A token without an expiry date is only advice: it works, but nothing bounds how long a leaked
// copy keeps working. GitHub sends the expiry header for any token that has an expiry date.
function checkExpiry(expiresAt, problems) {
  if (!expiresAt) {
    problems.push(problem("no-expiry", "The bot's token never expires, so a leaked copy would keep working.", "Regenerate it with an expiry date (90 days is a good default), then run roborepo github setup in your own terminal.", "warn"));
    return;
  }
  const msLeft = expiresAt.getTime() - Date.now();
  if (msLeft <= 0) problems.push(problem("expired", "The bot's token has expired.", SETUP_FIX));
  else if (msLeft < EXPIRING_DAYS * 86_400_000) {
    const days = Math.max(1, Math.ceil(msLeft / 86_400_000));
    problems.push(problem("expiring", `The bot's token expires in ${days} day${days === 1 ? "" : "s"}.`, SETUP_FIX, "warn"));
  }
}

// A classic token lists its scopes; anything beyond repo and read:org is more than agents need.
// A fine-grained token sends no scope list, so nothing here could confirm it can push but not
// administer, and setup asks for a classic token instead.
function checkScopes(scopes, problems) {
  if (!scopes) {
    problems.push(problem("fine-grained-token", "The bot's token is a fine-grained token, so RoboRepo cannot confirm what it is allowed to do.", "Make a classic token with only the repo and read:org scopes, then run roborepo github setup in your own terminal."));
    return;
  }
  const broad = scopes.filter((scope) => !REQUIRED_SCOPES.includes(scope));
  if (broad.length > 0) {
    problems.push(problem("broad-scopes", `The bot's token has broader access than agents need (${broad.join(", ")}).`, "Make a new token with only the repo and read:org scopes, then run roborepo github setup in your own terminal."));
  }
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    problems.push(problem("scopes-missing", `The bot's token lacks the ${missing.join(" and ")} scope.`, "Make a new token with the repo and read:org scopes, then run roborepo github setup in your own terminal."));
  }
}

// A finding only the repo's owner can fix, when you do not administer the repo, carries
// `owner: true`, and its fix asks you to send them the message.
const askOwner = (what) => `Ask the repo's owner to ${what}; send them the message below.`;

async function checkRepoAccess(bot, repo, botLogin, problems, userAdmin) {
  let permissions = {};
  try {
    permissions = (await githubClient.repository(bot, repo)).permissions || {};
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  if (!permissions.push) {
    const invited = (await githubClient.userInvitations(bot)).some((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());
    if (invited) {
      // The bot accepts the invitation itself, which setup does whoever sent it.
      problems.push(problem("invite-pending", `${botLogin} has been invited to ${repo} but has not accepted yet.`, "Run roborepo github setup in this repo, in your own terminal; it accepts the invitation as the bot."));
    } else if (userAdmin === false) {
      problems.push({ ...problem("not-collaborator", `${botLogin} is not a collaborator on ${repo}, and you are not an admin there, so setup cannot invite it.`, askOwner(`invite ${botLogin} with Write access`)), owner: true });
    } else {
      problems.push(problem("not-collaborator", `${botLogin} cannot push to ${repo}.`, "Run roborepo github setup in this repo, in your own terminal; it sends the invitation."));
    }
  } else if (permissions.admin) {
    problems.push(problem("bot-is-admin", `${botLogin} is an admin of ${repo}, so it could change the branch protection meant to limit it.`, userAdmin === false
      ? `Ask the repo's owner to lower ${botLogin} to Write access.`
      : `Lower ${botLogin} to write access in the repo's collaborator settings, then rerun roborepo github status.`));
  }
}

// Whether GitHub stops the bot from merging unreviewed work in this repo, from the protection
// report read as you. Rules that apply but whose bypass list you cannot see (you are not an admin)
// are `unverified`, never healthy: the owner could let the bot bypass them.
function checkProtection(report, problems, userAdmin) {
  if (report.state === "unavailable") {
    problems.push(problem("protection-unchecked", `Branch protection could not be read${report.reason ? ` (${report.reason})` : ""}, so this could not confirm GitHub stops the bot from merging unreviewed work.`, "Run roborepo protect --check in your own terminal.", "unchecked"));
    return;
  }
  const skipped = report.policies?.some((policy) => policy.status === "skipped");
  const applies = (report.state === "protected" || report.state === "unmanaged") && !skipped;
  if (applies && report.admin && report.bypassVerified) return;
  if (applies && report.admin) {
    // An admin of the repo still cannot read an organization ruleset's bypass list.
    problems.push(problem("protection-unverified", "GitHub applies the branch rules, but some come from an organization ruleset whose bypass list RoboRepo cannot read, so it cannot confirm the bot cannot bypass them.", "Ask an organization owner to confirm the bot cannot bypass them, or run roborepo protect to add the repo's own rules.", "unverified"));
    return;
  }
  if (applies) {
    problems.push({
      ...problem("protection-unverified", "GitHub applies the branch rules, but you are not an admin of this repo, so RoboRepo cannot see who may bypass them.", askOwner("confirm them, and that the bot cannot bypass them"), "unverified"),
      owner: true,
    });
    return;
  }
  const message = skipped
    ? "The merge rule that requires approval of the last push is skipped for this repo."
    : `Branch protection for this repo is ${report.state}, so GitHub does not stop the bot from merging unreviewed work.`;
  if (userAdmin === false) {
    problems.push({ ...problem("protection", message, askOwner("add the branch rules")), owner: true });
  } else if (userAdmin === true) {
    problems.push(problem("protection", message, "Run roborepo protect in this repo (it asks before changing anything), or open Branch protection in the repo's menu on Home."));
  } else {
    problems.push(problem("protection", message, "A repo admin should run roborepo protect (it asks before changing anything)."));
  }
}
