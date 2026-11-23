// Whether agents in a GitHub repo can act as the bot account safely: the bot is signed in with a
// token stored where agent sandboxes can read it, it is a different person from the user, it can
// push but not administer the repo, its token is not broader than it needs, and the repo's
// branches are protected. It only reads, except `refreshCaBundle`, which writes the CA bundle copy;
// the guided setup in scripts/cli/github-setup.mjs makes every other change.
import fs from "node:fs";
import path from "node:path";
import { GitHubError, forgeTargetForRepositoryId } from "./index.mjs";
import { githubClient } from "./github.mjs";
import { readProtection } from "./protection.mjs";

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
  const changedConfig = writeIfChanged(
    local,
    `# Codex's sandbox denies *.pem files, so Git reads a copy of the system CA bundle.\n[http "https://github.com/"]\n\tsslCAInfo = ${copy}\n`,
    0o644,
  );
  return { copied: true, changed: changedCopy || changedConfig };
}

function caBundleStale(stateDir) {
  const source = findSystemCaBundle();
  if (!source) return false;
  try {
    return Buffer.compare(fs.readFileSync(source), fs.readFileSync(agentCaBundleFile(stateDir))) !== 0;
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

// The result's `state` is `not-set-up`, `healthy`, `problem`, or `unavailable` (`reason` says why).
// `problems` entries are `{ id, message, fix, severity }`; `severity: "warn"` is advice (a token
// close to expiring) and does not make the state `problem`. `packageEnabled` is passed in by the
// caller, which knows the package state.
export async function readAgentIdentity({ repositoryId, cwd = process.cwd(), stateDir, timeoutMs, packageEnabled = false }) {
  const result = {
    state: "not-set-up", repository: null, botLogin: null, userLogin: null, packageEnabled,
    expiresAt: null, scopes: null, problems: [], reason: null,
  };
  const target = forgeTargetForRepositoryId(repositoryId);
  if (!target || target.host !== "github.com") return { ...result, state: "unavailable", reason: "this repo has no GitHub remote" };
  result.repository = target.repo;
  const hosts = readAgentHosts(stateDir);
  if (!hosts.loggedIn) {
    if (!packageEnabled) return result;
    return finish(result, [problem("bot-missing", "The package is on but no bot account is signed in.", SETUP_FIX)]);
  }

  const problems = [];
  const bot = { cwd, timeoutMs, env: botGhEnv(stateDir) };
  // The user's own account, even from a shell that points GH_CONFIG_DIR at the bot.
  const user = { cwd, timeoutMs, env: { GH_CONFIG_DIR: null } };
  try {
    if (!packageEnabled) problems.push(problem("package-off", "A bot is signed in but the github-agent-identity package is off, so agents still act as you.", SETUP_FIX));
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
        return finish(result, problems);
      }
      throw error;
    }
    result.botLogin = info.login;
    result.scopes = info.scopes;
    result.expiresAt = info.expiresAt ? info.expiresAt.toISOString() : null;
    problems.push(...tokenProblems(info));

    result.userLogin = await githubClient.login(user).catch(() => null);
    if (!result.userLogin) {
      problems.push(problem("account-unchecked", "Your own GitHub sign-in could not be read, so this could not confirm the bot is a different account.", "Run gh auth status in your own terminal, then rerun roborepo github status.", "warn"));
    } else if (result.userLogin.toLowerCase() === info.login.toLowerCase()) {
      problems.push(problem("bot-is-user", `The bot account ${info.login} is your own account, so agents would have your access.`, SETUP_FIX));
    }
    await checkRepoAccess(bot, target.repo, info.login, problems);
    await checkProtection({ repositoryId, cwd, timeoutMs }, problems);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // A problem already found stays reported: a later read failing does not make it go away.
    if (problems.some((entry) => entry.severity === "problem")) {
      return finish(result, [...problems, problem("check-incomplete", `Some checks could not run: ${error.message}.`, "Rerun roborepo github status once GitHub answers.", "warn")]);
    }
    return { ...result, problems, state: "unavailable", reason: error.message };
  }
  return finish(result, problems);
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

function problem(id, message, fix, severity = "problem") {
  return { id, message, fix, severity };
}

function finish(result, problems) {
  const blocking = problems.some((entry) => entry.severity === "problem");
  return { ...result, problems, state: blocking ? "problem" : "healthy" };
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

async function checkRepoAccess(bot, repo, botLogin, problems) {
  let permissions = {};
  try {
    permissions = (await githubClient.repository(bot, repo)).permissions || {};
  } catch (error) {
    if (!(error instanceof GitHubError) || error.status !== 404) throw error;
  }
  if (!permissions.push) {
    const invited = (await githubClient.userInvitations(bot)).some((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());
    problems.push(problem("not-collaborator", invited
      ? `${botLogin} has been invited to ${repo} but has not accepted yet.`
      : `${botLogin} cannot push to ${repo}.`, SETUP_FIX));
  } else if (permissions.admin) {
    problems.push(problem("bot-is-admin", `${botLogin} is an admin of ${repo}, so it could change the branch protection meant to limit it.`, `Lower ${botLogin} to write access in the repo's collaborator settings, then rerun roborepo github status.`));
  }
}

async function checkProtection(target, problems) {
  const report = await readProtection(target);
  if (report.state === "unavailable") {
    problems.push(problem("protection-unchecked", `Branch protection could not be read${report.reason ? ` (${report.reason})` : ""}, so this could not confirm GitHub stops the bot from merging unreviewed work.`, "Run roborepo protect --check in your own terminal.", "warn"));
    return;
  }
  const skipped = report.policies?.some((policy) => policy.status === "skipped");
  if (report.state === "protected" && !skipped) return;
  const message = skipped
    ? "The merge rule that requires approval of the last push is skipped for this repo."
    : `Branch protection for this repo is ${report.state}, so GitHub does not stop the bot from merging unreviewed work.`;
  problems.push(problem("protection", message, "A repo admin should run roborepo protect (it asks before changing anything)."));
}
