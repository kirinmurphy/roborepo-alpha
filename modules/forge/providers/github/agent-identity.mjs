// The GitHub provider's `agent-identity` capability: what only GitHub knows about the bot account
// agents act as. Its token lives in a gh config folder under the provider's state folder, its
// scopes and expiry come from GitHub's response headers, its repo access is a collaborator
// invitation, and its commits use GitHub's noreply address. The generic reader
// (modules/forge/agent-identity.mjs) turns these into states and findings; the shared setup
// (scripts/cli/forge-setup.mjs) runs the setup methods in order.
import fs from "node:fs";
import path from "node:path";
import {
  TokenRejected, askOwner, expiryProblems, finding, setupCommand, setupFix, statusCommand, stopSetup,
} from "../../agent-identity-findings.mjs";
import { GitHubError, githubClient, runGh } from "./client.mjs";
import { githubManifest, githubSelf } from "./manifest.mjs";
import { GITHUB_PAGES, TOKEN_NOTE, TOKEN_SCOPES, expiryAdvice, scopesText, setupGuide } from "./agent-identity-guide.mjs";
import { MANUAL_STEPS } from "./protection.mjs";

const { cli, agent } = githubManifest;
const REQUIRED_SCOPES = TOKEN_SCOPES;
const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

export const agentStateDir = (stateDir) => path.join(stateDir, agent.stateFolder);
export const agentGhConfigDir = (stateDir) => path.join(agentStateDir(stateDir), cli.configSubfolder);

// The environment for a gh call made as the bot. GH_TOKEN and GITHUB_TOKEN take precedence over
// the stored login, so a token the user exported would make the call run as the user; null removes
// them (runGh deletes null entries). `dir` defaults to the bot's config directory; setup passes a
// staging directory to try a new token before it replaces the live one.
export const botGhEnv = (stateDir, dir = agentGhConfigDir(stateDir)) => ({
  [cli.configDirVariable]: dir, ...Object.fromEntries(cli.tokenVariables.map((name) => [name, null])),
});
// Your own account, even from a shell that points GH_CONFIG_DIR at the bot.
export const userGhEnv = () => ({ [cli.configDirVariable]: null });

export const agentCaBundleFile = (stateDir) => path.join(agentStateDir(stateDir), "ca-bundle.crt");
export const agentCaGitconfigFile = (stateDir) => path.join(agentStateDir(stateDir), "gitconfig.local");
export const agentAuthorGitconfigFile = (stateDir) => path.join(agentStateDir(stateDir), "gitconfig.author");
export const agentHostsFile = (stateDir) => path.join(agentGhConfigDir(stateDir), "hosts.yml");

// Where the system's CA bundle usually lives. ROBOREPO_SYSTEM_CA_BUNDLE replaces the list with one
// path, so tests can point at a fixture instead of the machine's real bundle.
const CA_BUNDLE_CANDIDATES = ["/etc/ssl/cert.pem", "/etc/ssl/certs/ca-certificates.crt", "/etc/pki/tls/certs/ca-bundle.crt"];

export function findSystemCaBundle() {
  const override = process.env.ROBOREPO_SYSTEM_CA_BUNDLE;
  return (override ? [override] : CA_BUNDLE_CANDIDATES).find((file) => fs.existsSync(file)) || null;
}

// Written beside the destination and renamed over it, so Git in a running agent shell reads the old
// file or the new one, never a partial write.
function writeIfChanged(file, content, mode) {
  try {
    if (Buffer.compare(fs.readFileSync(file), Buffer.from(content)) === 0) return false;
  } catch {}
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, content, { mode });
    fs.chmodSync(temporary, mode);
    fs.renameSync(temporary, file);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
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

// Agents' commits name the bot as their author, at the noreply address GitHub links to its account,
// so a commit shows who made it as plainly as the push does. The package's gitconfig includes this
// file; Git ignores the include until setup writes it. Returns whether the file changed.
export function writeAgentAuthor({ stateDir, login, id }) {
  return writeIfChanged(agentAuthorGitconfigFile(stateDir), agentAuthorGitconfig({ login, id }), 0o644);
}

export const agentNoreplyEmail = ({ login, id }) => `${id}+${login}@users.noreply.github.com`;
const agentAuthorGitconfig = ({ login, id }) => `# Agents' commits are authored by the bot account.\n[user]\n\tname = ${login}\n\temail = ${agentNoreplyEmail({ login, id })}\n`;

// Every section names github.com, the provider's only host: the bot's CA copy never reaches
// another host's connections.
const caGitconfig = (copy) => `# Codex's sandbox denies *.pem files, so Git reads a copy of the system CA bundle.\n[http "https://github.com/"]\n\tsslCAInfo = ${gitConfigString(copy)}\n`;

// A path holding `#`, `;`, a quote, a backslash, or edge spaces goes in double quotes, so Git does
// not cut it short as a comment. Any other path stays bare, so an existing install's file is unchanged.
const gitConfigString = (value) => (/[#;"\\]|^\s|\s$/.test(value)
  ? `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`
  : value);

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

// What is wrong with a token by itself, from `githubClient.tokenInfo`: its expiry and its scopes.
// Setup uses it to judge a new token before installing it, and to offer replacing one that works
// but is expiring, has no expiry date, or has the wrong scopes.
export function tokenProblems(info) {
  return [...expiryProblems(info.expiresAt, githubSelf), ...scopeProblems(info.scopes)];
}

// A classic token lists its scopes; anything beyond repo and read:org is more than agents need.
// A fine-grained token sends no scope list, so nothing here could confirm it can push but not
// administer, and setup asks for a classic token instead.
function scopeProblems(scopes) {
  const setup = setupCommand(githubSelf);
  if (!scopes) {
    return [finding("fine-grained-token", "The bot's token is a fine-grained token, so RoboRepo cannot confirm what it is allowed to do.", `Make a classic token with only the repo and read:org scopes, then run ${setup} in your own terminal.`)];
  }
  const problems = [];
  const broad = scopes.filter((scope) => !REQUIRED_SCOPES.includes(scope));
  if (broad.length > 0) {
    problems.push(finding("broad-scopes", `The bot's token has broader access than agents need (${broad.join(", ")}).`, `Make a new token with only the repo and read:org scopes, then run ${setup} in your own terminal.`));
  }
  const missing = REQUIRED_SCOPES.filter((scope) => !scopes.includes(scope));
  if (missing.length > 0) {
    problems.push(finding("scopes-missing", `The bot's token lacks the ${missing.join(" and ")} scope.`, `Make a new token with the repo and read:org scopes, then run ${setup} in your own terminal.`));
  }
  return problems;
}

// Findings a scope change makes: regenerating keeps a token's scopes, so these need a new token.
const WRONG_SCOPE_FINDINGS = new Set(["broad-scopes", "fine-grained-token", "scopes-missing"]);

// What the machine's own files say before any GitHub call: a token in the keychain, which agent
// sandboxes cannot read, and a stale CA bundle copy, which only setup refreshes.
function localFileProblems(stateDir, hosts = readAgentHosts(stateDir)) {
  const problems = [];
  if (!hosts.hasToken) {
    problems.push(finding("token-in-keychain", "The bot's token is in the keychain, which agent sandboxes cannot read.", setupFix(githubSelf)));
  }
  if (caBundleStale(stateDir)) {
    problems.push(finding("ca-bundle-stale", "The certificate bundle copy Codex's sandbox uses for Git is missing or out of date.", `Run ${setupCommand(githubSelf)} to refresh it.`, "warn"));
  }
  return problems;
}

// Whether the bot can push to one repo: invited, invitation pending, or admin, which is too much.
// Returns the findings; `userAdmin` decides who can fix one, you or the repo's owner.
async function readRepoAccess(bot, repo, botLogin, { userAdmin }) {
  const problems = [];
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
      problems.push(finding("invite-pending", `${botLogin} has been invited to ${repo} but has not accepted yet.`, `Run ${setupCommand(githubSelf)} in this repo, in your own terminal; it accepts the invitation as the bot.`));
    } else if (userAdmin === false) {
      problems.push({ ...finding("not-collaborator", `${botLogin} is not a collaborator on ${repo}, and you are not an admin there, so setup cannot invite it.`, askOwner(`invite ${botLogin} with Write access`)), owner: true });
    } else {
      problems.push(finding("not-collaborator", `${botLogin} cannot push to ${repo}.`, `Run ${setupCommand(githubSelf)} in this repo, in your own terminal; it sends the invitation.`));
    }
  } else if (permissions.admin) {
    problems.push(finding("bot-is-admin", `${botLogin} is an admin of ${repo}, so it could change the branch protection meant to limit it.`, userAdmin === false
      ? `Ask the repo's owner to lower ${botLogin} to Write access.`
      : `Lower ${botLogin} to write access in the repo's collaborator settings, then rerun ${statusCommand(githubSelf)}.`));
  }
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

const pendingInvitation = async (bot, repo) => (await githubClient.userInvitations(bot))
  .find((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());

// Accepts the bot's own pending invitation to a repo, which needs no admin rights. True when there
// was one.
async function acceptInvitation(bot, repo) {
  const pending = await pendingInvitation(bot, repo);
  if (pending) await githubClient.acceptInvitation(bot, pending.id);
  return Boolean(pending);
}

// Gives the bot Write access to a repo, as you: `collaborator` when it already can push, `raised`
// when a Read collaborator became Write, `pending` when an invitation is already waiting, and
// `invited` when one was sent. A refusal (only an admin can invite) throws GitHub's error.
async function invite(user, repo, botLogin) {
  const permission = await githubClient.collaboratorPermission(user, repo, botLogin);
  if (permission === "write" || permission === "admin") return { outcome: "collaborator", message: `${botLogin} is a collaborator` };
  // A Read collaborator is a collaborator that cannot push: its role is raised, not re-invited.
  if (permission === "read") {
    await githubClient.inviteCollaborator(user, repo, botLogin);
    return { outcome: "raised", message: `Gave ${botLogin} Write access to ${repo} (it had Read).` };
  }
  const invited = (await githubClient.repoInvitations(user, repo)).some((invitation) => invitation.invitee?.login?.toLowerCase() === botLogin.toLowerCase());
  if (invited) return { outcome: "pending", message: `Invitation: ${botLogin} already has a pending invitation.` };
  await githubClient.inviteCollaborator(user, repo, botLogin);
  return { outcome: "invited", message: `Invited ${botLogin} to ${repo}.` };
}

// Asks for the bot's token and installs it. `issues` are what is wrong with a token that still
// works; a token with the wrong scopes is replaced by a new one, since regenerating keeps scopes.
async function storeToken({ input, io, cwd, stateDir, botLogin, hadLogin, renewing, issues = [] }) {
  const hosts = readAgentHosts(stateDir);
  if (hadLogin && !hosts.hasToken) {
    io.log("The saved login keeps its token in the keychain, so it is replaced.");
  }
  if (renewing && !issues.some((entry) => WRONG_SCOPE_FINDINGS.has(entry.id))) {
    // Regenerating keeps the token's note and scopes and only issues a new value and expiry.
    io.log(`In the browser where ${botLogin} is signed in, open ${GITHUB_PAGES.tokens}`);
    io.log(`Open the "${TOKEN_NOTE}" token and choose Regenerate token, or make a new classic token with only the ${TOKEN_SCOPES.join(" and ")} scopes.`);
  } else {
    io.log(`In the browser where ${botLogin} is signed in, open ${GITHUB_PAGES.newToken} (a classic token).`);
    io.log(`Note: "${TOKEN_NOTE}". Scopes: ${scopesText()}.`);
  }
  io.log(`Expiry: ${expiryAdvice()}`);
  io.log("Do not paste the token into an agent chat.");
  io.log(`Agents' sandboxes cannot read the keychain, so the token is stored in ${agentHostsFile(stateDir)}.`);
  const token = (await input.askHidden("Paste the token (input hidden): ")).trim();
  if (!token) stopSetup("No token given.");
  await installToken({ token, cwd, stateDir, botLogin });
  io.log(`✓ Token stored; signed in as ${botLogin}.`);
}

// Moves a working token gh put in the keychain (agents' sandboxes cannot read it) to the agent
// directory, through the same checks as a pasted one. Your own terminal can read the keychain;
// agents cannot. Returns false when gh has no token to give, or the checks reject it (its scopes,
// say), so the caller asks for a new one instead. Only applies when the stored login has no token
// in its file; `true` also means the file now holds it.
async function moveStoredToken({ cwd, stateDir, botLogin, io }) {
  if (readAgentHosts(stateDir).hasToken) return false;
  const token = (await runGh(cwd, ["auth", "token", "--hostname", "github.com"], "", { env: botGhEnv(stateDir) }).catch(() => "")).trim();
  if (!token) return false;
  try {
    await installToken({ token, cwd, stateDir, botLogin });
  } catch (error) {
    if (!(error instanceof TokenRejected)) throw error;
    io.log(`The token in the keychain was not moved: ${error.findings.map((entry) => entry.message).join(" ")} Make a new one below.`);
    return false;
  }
  io.log(`✓ Token: moved from the keychain to ${agentHostsFile(stateDir)}, where agents can read it.`);
  return true;
}

// Signs the token in to a staging folder and checks it there. Only a token for the right account
// with acceptable scopes replaces the live login, so a rejected one never reaches agents and the
// previous token keeps working. Each run stages in its own private folder beside the live one (the
// same filesystem, so the rename is atomic), so two setups at once never promote each other's token.
async function installToken({ token, cwd, stateDir, botLogin }) {
  const dir = agentGhConfigDir(stateDir);
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  const staging = fs.mkdtempSync(path.join(path.dirname(dir), "gh-staging-"));
  try {
    const stagedBot = { cwd, env: botGhEnv(stateDir, staging) };
    try {
      await runGh(cwd, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"], `${token}\n`, { env: stagedBot.env });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || "").split(token).join("***").trim();
      stopSetup(`gh could not sign the bot in${detail ? `: ${detail}` : ""}. Nothing was changed.`);
    }
    const info = await githubClient.tokenInfo(stagedBot).catch(() => null);
    if (!info?.login || !sameLogin(info.login, botLogin)) {
      stopSetup(info?.login
        ? `That token belongs to ${info.login}, not ${botLogin}. It was not stored; rerun with the right token.`
        : "GitHub did not accept that token. It was not stored; rerun with a new token.");
    }
    const blocking = tokenProblems(info).filter((entry) => entry.severity === "problem");
    if (blocking.length > 0) {
      throw Object.assign(new TokenRejected(`That token was not stored: ${blocking.map((entry) => entry.message).join(" ")} Fix: ${blocking[0].fix}`), { findings: blocking });
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.renameSync(path.join(staging, "hosts.yml"), agentHostsFile(stateDir));
    fs.chmodSync(agentHostsFile(stateDir), 0o600);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

// The files setup writes beside the token, refreshed before the final check. Returns the lines
// setup prints.
function refreshLocalFiles(stateDir) {
  const ca = refreshCaBundle({ stateDir });
  return ca.copied ? [ca.changed ? "✓ certificate bundle: copied for Codex's sandbox" : "✓ certificate bundle: already current"] : [];
}

// The bot as the author of agents' commits in repos on this provider's hosts.
async function writeAuthor({ user, stateDir, login }) {
  const id = await githubClient.accountId(user, login);
  const changed = writeAgentAuthor({ stateDir, login, id });
  return { changed, ident: `${login} <${agentNoreplyEmail({ login, id })}>` };
}

// Messages setup prints while it creates the bot account, using the guide's pages.
const createAccountLines = () => [
  "Agents act as a separate GitHub account, not as you.",
  `Create one in a private window or another browser, so your own session stays signed in: ${GITHUB_PAGES.signup}`,
  "Pick any name; it will show on every pull request and comment an agent makes.",
];

// Why your own sign-in could not be read, as setup reports it: signing in again fixes only a missing
// or rejected sign-in, not GitHub being out of reach.
const userSignInRefusal = (error) => {
  const signedOut = error.status === 401 || /not signed in/.test(error.message);
  return signedOut ? "GitHub CLI is not signed in as you. Run gh auth login, then rerun this." : `Could not read your own GitHub sign-in: ${error.message}.`;
};

export const githubAgentIdentity = {
  readStoredLogin: readAgentHosts,
  credentialsFile: agentHostsFile,
  agentEnv: botGhEnv,
  userEnv: userGhEnv,
  readAccount: (context) => githubClient.tokenInfo(context),
  readLogin: (context) => githubClient.login(context),
  accountProblems: tokenProblems,
  readRepoAccess,
  localFileProblems,
  authorIdentity: agentNoreplyEmail,
  ownerMessage,
  guide: setupGuide,
  accountLogin: (context, login) => githubClient.accountLogin(context, login),
  accountId: (context, login) => githubClient.accountId(context, login),
  invite,
  acceptInvitation,
  storeToken,
  installToken,
  moveStoredToken,
  refreshLocalFiles,
  writeAuthor,
  createAccountLines,
  userSignInRefusal,
  // The command that checks your own sign-in, named when it could not be read.
  userSignInCheck: "gh auth status",
  // Warnings only setup clears, so turning the package on is not the one step left while they stand.
  setupOnlyWarnings: new Set(["ca-bundle-stale"]),
};
