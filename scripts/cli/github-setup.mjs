// `roborepo github setup`: guided setup of the bot account agents act as on GitHub. Every step
// checks first and skips itself when already done, so rerunning is safe. It runs in the user's own
// terminal: it reads the bot's token without echo and hands it to `gh` on stdin, never through an
// argument, a file RoboRepo writes, or the output.
import fs from "node:fs";
import path from "node:path";
import readline from "node:readline";
import { GitHubError, forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { githubClient, runGh } from "../../modules/forge/github.mjs";
import {
  agentGhConfigDir, agentHostsFile, botGhEnv, readAgentHosts, readAgentIdentity,
  agentNoreplyEmail, refreshCaBundle, tokenProblems, writeAgentAuthor,
} from "../../modules/forge/agent-identity.mjs";
import { GITHUB_PAGES, TOKEN_NOTE, TOKEN_SCOPES, expiryAdvice, scopesText } from "../../modules/forge/agent-identity-guide.mjs";
import { applyProtection, readProtection } from "../../modules/forge/protection.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { agentGitRoutingGaps, agentIdentityPackageInstalled, turnOnAgentIdentityPackage } from "./agent-identity-package.mjs";
import { stateDir } from "./state-paths.mjs";

const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

class Stop extends Error {}
const stop = (message) => { throw new Stop(message); };

// The CLI entry. Setup reads a token and asks questions, so it only ever runs with a real terminal
// on both ends; there is no switch around that. Tests call `runSetup` with their own input source.
export async function githubSetupCommand() {
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error("roborepo github setup asks questions and reads a token, so it needs your own terminal. Run it there.");
    process.exitCode = 1;
    return;
  }
  const input = interactiveInput();
  try {
    process.exitCode = await runSetup({ input });
  } finally {
    input.close();
  }
}

// Runs the guided setup and returns the exit code. `input` supplies answers (ask, askHidden), `io`
// receives the output. GitHub pages are printed, never opened: they are done signed in as the bot,
// and the default browser is usually signed in as you.
export async function runSetup({ input, io = { log: console.log, error: console.error }, cwd = process.cwd() }) {
  try {
    return await guidedSetup({ input, io, cwd });
  } catch (error) {
    if (error instanceof Stop) {
      io.error(error.message);
      return 1;
    }
    if (error instanceof GitHubError) {
      io.error(`GitHub: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function guidedSetup({ input, io, cwd }) {
  const done = (step) => io.log(`✓ ${step}: already done`);
  const dir = agentGhConfigDir(stateDir);
  const user = { cwd, env: { GH_CONFIG_DIR: null } };
  const bot = { cwd, env: botGhEnv(stateDir) };

  // 1. The repo and the user's own sign-in.
  const repositoryId = await currentRepositoryId(cwd);
  const target = forgeTargetForRepositoryId(repositoryId);
  if (target?.host !== "github.com") stop("This repo has no GitHub origin, so there is nothing to set up.");
  const repo = target.repo;
  let userLogin;
  try {
    userLogin = await githubClient.login(user);
  } catch {
    stop("GitHub CLI is not signed in as you. Run gh auth login, then rerun this.");
  }
  io.log(`✓ You are ${userLogin}, setting up ${repo}.`);

  // 2. The bot account.
  let hosts = readAgentHosts(stateDir);
  let botLogin = null;
  let renewing = false;
  if (hosts.loggedIn) botLogin = await githubClient.login(bot).catch(() => null);
  // GitHub no longer accepts the saved token (it expired or was revoked), but hosts.yml still names
  // the bot, so this run renews the token instead of walking through creating an account.
  if (!botLogin && hosts.user && !sameLogin(hosts.user, userLogin)) {
    botLogin = await githubClient.accountLogin(user, hosts.user);
    renewing = Boolean(botLogin);
  }
  if (renewing) {
    io.log(`✓ Bot account: ${botLogin} (GitHub no longer accepts its saved token, so you will paste a new one)`);
  } else if (botLogin) {
    done(`Bot account (${botLogin})`);
  } else {
    io.log("Agents act as a separate GitHub account, not as you.");
    io.log(`Create one in a private window or another browser, so your own session stays signed in: ${GITHUB_PAGES.signup}`);
    io.log("Pick any name; it will show on every pull request and comment an agent makes.");
    const typed = (await input.ask("Bot account login: ")).trim();
    if (!typed) stop("No bot account login given.");
    if (sameLogin(typed, userLogin)) stop("The bot must be a different account from your own.");
    // GitHub's own spelling of the login is the one every later comparison uses.
    botLogin = await githubClient.accountLogin(user, typed);
    if (!botLogin) stop(`GitHub has no account named ${typed}. Create it first, then rerun this.`);
    io.log(`✓ Bot account: ${botLogin}`);
  }
  if (sameLogin(botLogin, userLogin)) stop("The signed-in bot is your own account. Sign out of it with gh auth logout, then rerun this.");

  // 3. Invite the bot to the repo, as the user.
  await inviteBot({ user, repo, botLogin, io, done });

  // 4. The bot's token, stored in the agent directory. A working token that gh put in the keychain
  // (agents' sandboxes cannot read it) is moved to the agent directory, not asked for again.
  if (hosts.loggedIn && !hosts.hasToken && botLogin && !renewing) {
    const moved = await moveKeychainToken({ cwd, dir, botLogin, bot });
    if (moved) io.log(`✓ Token: moved from the keychain to ${agentHostsFile(stateDir)}, where agents can read it.`);
    hosts = readAgentHosts(stateDir);
  }
  const tokenOk = botLogin && hosts.loggedIn && hosts.hasToken && await githubClient.login(bot).then((login) => sameLogin(login, botLogin), () => false);
  // A token that still works may still need replacing: it expires soon, never expires, or has the
  // wrong scopes. Offer it here, so a rerun can renew before agents start failing.
  const tokenIssues = tokenOk ? tokenProblems(await githubClient.tokenInfo(bot)) : [];
  let replace = !tokenOk;
  if (tokenIssues.length > 0) {
    for (const entry of tokenIssues) io.log(`Note: ${entry.message}`);
    const answer = (await input.ask("Replace the bot's token now? [Y/n] ")).trim().toLowerCase();
    replace = answer === "" || answer === "y" || answer === "yes";
  }
  if (replace) {
    // Regenerating a token keeps its scopes, so a token with the wrong ones is replaced by a new one.
    const wrongScopes = tokenIssues.some((entry) => WRONG_SCOPE_FINDINGS.has(entry.id));
    await storeToken({ input, io, cwd, dir, botLogin, hadLogin: hosts.loggedIn, renewing: (renewing || tokenOk) && !wrongScopes });
  } else {
    done("Token");
  }

  // 5. The bot accepts the invitation.
  const pending = (await githubClient.userInvitations(bot)).find((invitation) => invitation.repository?.full_name?.toLowerCase() === repo.toLowerCase());
  if (pending) {
    await githubClient.acceptInvitation(bot, pending.id);
    io.log(`✓ Invitation accepted as ${botLogin}.`);
  } else {
    done("Invitation accepted");
  }

  // 6. Branch protection.
  // As you, even from a terminal whose GH_CONFIG_DIR names another sign-in, like every other user step.
  const protectTarget = { repositoryId, cwd, env: user.env };
  const before = await readProtection(protectTarget);
  if (before.state === "protected" && !before.policies.some((policy) => policy.status === "skipped")) {
    done("Branch protection");
  } else {
    const answer = (await input.ask("Protect the plans and default branches now? [Y/n] ")).trim().toLowerCase();
    if (answer === "" || answer === "y" || answer === "yes") {
      const result = await applyProtection(protectTarget);
      io.log(result.refusal ? `Branch protection: ${result.refusal}.` : `✓ Branch protection is now ${result.report.state}.`);
    } else {
      io.log("Skipping branch protection; the final check will report it.");
    }
  }

  // 7. The certificate bundle copy Codex's sandbox reads (it denies *.pem), refreshed before the check.
  const ca = refreshCaBundle({ stateDir });
  if (ca.copied) io.log(ca.changed ? "✓ certificate bundle: copied for Codex's sandbox" : "✓ certificate bundle: already current");

  // The bot as the author of agents' commits.
  const botId = await githubClient.accountId(user, botLogin);
  const authorChanged = writeAgentAuthor({ stateDir, login: botLogin, id: botId });
  io.log(`✓ commit author: ${authorChanged ? "agents' commits in github.com repos are now authored by" : "already"} ${botLogin} <${agentNoreplyEmail({ login: botLogin, id: botId })}>`);

  // 8. Check everything before agents switch over.
  const report = await readAgentIdentity({ repositoryId, cwd, stateDir, packageEnabled: true });
  const blocking = report.problems.filter((entry) => entry.severity === "problem");
  // A failed check never turns the package off, so a bot already in use stays in use.
  const alreadyOn = await agentIdentityPackageInstalled();
  for (const entry of report.problems.filter((item) => item.severity === "warn" || item.severity === "unverified")) io.log(`Note: ${entry.message}`);
  // Setup confirms nothing it could not check: an unread account or branch protection stops here.
  if (report.state === "unavailable") stop(`Could not check the result: ${report.reason}. Setup does not turn the package on until every check runs.`);
  if (blocking.length > 0) {
    io.error(alreadyOn
      ? "The bot is not ready. The package was already on and stays on, so agents still act as the bot and may fail on GitHub until this is fixed:"
      : "The bot is not ready, so agents keep acting as you:");
    for (const entry of blocking) io.error(`  - ${entry.message}\n    Fix: ${entry.fix}`);
    if (report.ownerMessage) io.error(`\nMessage for the repo's owner:\n${report.ownerMessage}`);
    return 1;
  }
  // Rules that apply but whose bypass list could not be read may let the bot merge unreviewed work,
  // so the package stays off until someone who can see them confirms them.
  if (report.state === "unverified") {
    io.error(alreadyOn
      ? "The branch rules could not be verified. The package was already on and stays on, so agents still act as the bot; confirm the rules, or turn the bot off in Settings."
      : "The branch rules could not be verified, so the package stays off and agents keep acting as you.");
    for (const entry of report.problems.filter((item) => item.severity === "unverified")) io.error(`  - ${entry.message}\n    Fix: ${entry.fix}`);
    if (report.ownerMessage) io.error(`\nMessage for the repo's owner:\n${report.ownerMessage}`);
    return 1;
  }
  io.log("✓ Check: the bot account, its access and the branch protection all look right.");

  // 9. Turn the package on. Enabling again re-applies every resource, which repairs one left
  // missing when an earlier enable failed partway; that includes the pair that makes each harness's
  // agent shells include the bot's Git settings. A harness whose config is missing still pushes as
  // the user, and `roborepo update` writes it, so setup stops there rather than report success.
  const gapsBefore = agentGitRoutingGaps();
  if (await agentIdentityPackageInstalled()) {
    if (gapsBefore.length === 0) done("Package on");
  } else {
    const turnedOn = await turnOnAgentIdentityPackage();
    if (!turnedOn.ok) stop(`${turnedOn.message} Agents may not act as ${botLogin}; see the messages above.`);
  }
  const gaps = agentGitRoutingGaps();
  if (gaps.length > 0) {
    stop(`The package is on, but your ${gaps.join(" and ")} settings don't include the bot's Git settings yet, so agents' git pushes still go out as you. Run roborepo update, then rerun this.`);
  }
  io.log(`Agents now act on GitHub as ${botLogin}. New agent sessions pick this up.`);
  return 0;
}

async function inviteBot({ user, repo, botLogin, io, done }) {
  try {
    if (await githubClient.isCollaborator(user, repo, botLogin)) {
      done(`Invitation (${botLogin} is a collaborator)`);
      return;
    }
    const invited = (await githubClient.repoInvitations(user, repo)).some((invitation) => invitation.invitee?.login?.toLowerCase() === botLogin.toLowerCase());
    if (invited) {
      io.log(`✓ Invitation: ${botLogin} already has a pending invitation.`);
      return;
    }
    await githubClient.inviteCollaborator(user, repo, botLogin);
  } catch (error) {
    if (!(error instanceof GitHubError)) throw error;
    // Only an admin can see or send invitations. The token step that follows is the bot account's
    // own and still worth finishing; the final check names what the repo's owner has to do here.
    io.log(`You cannot invite ${botLogin} to ${repo} (GitHub: ${error.message}); only a repo admin can. If someone else owns it, the final check prints a message to send them. Continuing with the bot account.`);
    return;
  }
  io.log(`✓ Invited ${botLogin} to ${repo}.`);
}

const WRONG_SCOPE_FINDINGS = new Set(["broad-scopes", "fine-grained-token", "scopes-missing"]);

async function storeToken({ input, io, cwd, dir, botLogin, hadLogin, renewing }) {
  const hosts = readAgentHosts(stateDir);
  if (hadLogin && !hosts.hasToken) {
    io.log("The saved login keeps its token in the keychain, so it is replaced.");
  }
  if (renewing) {
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
  if (!token) stop("No token given.");
  await installToken({ token, cwd, dir, botLogin });
  io.log(`✓ Token stored; signed in as ${botLogin}.`);
}

// Reads the token gh keeps in the keychain for the bot's login and stores it in the agent directory
// through the same checks as a pasted one. Your own terminal can read the keychain; agents cannot.
// Returns false when gh has no token to give, so the caller asks for one instead.
async function moveKeychainToken({ cwd, dir, botLogin, bot }) {
  const token = (await runGh(cwd, ["auth", "token", "--hostname", "github.com"], "", { env: bot.env }).catch(() => "")).trim();
  if (!token) return false;
  await installToken({ token, cwd, dir, botLogin });
  return true;
}

// Signs the token in to a staging folder and checks it there. Only a token for the right account
// with acceptable scopes replaces the live login, so a rejected one never reaches agents and the
// previous token keeps working.
async function installToken({ token, cwd, dir, botLogin }) {  const staging = path.join(path.dirname(dir), "gh-staging");
  fs.rmSync(staging, { recursive: true, force: true });
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  try {
    const stagedBot = { cwd, env: botGhEnv(stateDir, staging) };
    try {
      await runGh(cwd, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"], `${token}\n`, { env: stagedBot.env });
    } catch (error) {
      const detail = String(error?.stderr || error?.message || "").split(token).join("***").trim();
      stop(`gh could not sign the bot in${detail ? `: ${detail}` : ""}. Nothing was changed.`);
    }
    const info = await githubClient.tokenInfo(stagedBot).catch(() => null);
    if (!info?.login || !sameLogin(info.login, botLogin)) {
      stop(info?.login
        ? `That token belongs to ${info.login}, not ${botLogin}. It was not stored; rerun with the right token.`
        : "GitHub did not accept that token. It was not stored; rerun with a new token.");
    }
    const blocking = tokenProblems(info).filter((entry) => entry.severity === "problem");
    if (blocking.length > 0) {
      stop(`That token was not stored: ${blocking.map((entry) => entry.message).join(" ")} Fix: ${blocking[0].fix}`);
    }
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
    fs.chmodSync(dir, 0o700);
    fs.renameSync(path.join(staging, "hosts.yml"), agentHostsFile(stateDir));
    fs.chmodSync(agentHostsFile(stateDir), 0o600);
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}

function interactiveInput() {
  return {
    ask(question) {
      const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
      return new Promise((resolve) => rl.question(question, (answer) => { rl.close(); resolve(answer); }));
    },
    askHidden(question) {
      process.stdout.write(question);
      return new Promise((resolve, reject) => {
        let text = "";
        const finish = (fn) => {
          process.stdin.setRawMode(false);
          process.stdin.pause();
          process.stdin.removeListener("data", onData);
          process.stdout.write("\n");
          fn();
        };
        const onData = (chunk) => {
          for (const char of chunk.toString("utf8")) {
            if (char === "\r" || char === "\n") return finish(() => resolve(text));
            if (char === "\u0003") return finish(() => reject(new Stop("Cancelled.")));
            if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
            else text += char;
          }
        };
        process.stdin.setRawMode(true);
        process.stdin.resume();
        process.stdin.on("data", onData);
      });
    },
    close() {},
  };
}
