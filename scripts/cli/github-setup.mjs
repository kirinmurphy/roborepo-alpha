// `roborepo github setup`: guided setup of the bot account agents act as on GitHub. Every step
// checks first and skips itself when already done, so rerunning is safe. It runs in the user's own
// terminal: it reads the bot's token without echo and hands it to `gh` on stdin, never through an
// argument, a file RoboRepo writes, or the output.
import { spawn } from "node:child_process";
import fs from "node:fs";
import readline from "node:readline";
import { GitHubError, forgeTargetForRepositoryId } from "../../modules/forge/index.mjs";
import { githubClient, runGh } from "../../modules/forge/github.mjs";
import {
  AGENT_IDENTITY_PACKAGE_ID, EXPIRING_DAYS, agentGhConfigDir, agentHostsFile, readAgentHosts, readAgentIdentity, refreshCaBundle,
} from "../../modules/forge/agent-identity.mjs";
import { applyProtection, readProtection } from "../../modules/forge/protection.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import { agentIdentityPackageEnabled } from "./agent-identity-package.mjs";
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
    process.exitCode = await runSetup({ input, open: openInBrowser });
  } finally {
    input.close();
  }
}

// Opens a page with the platform opener; the URL is always printed too, so a failure costs nothing.
function openInBrowser(url) {
  const win = process.platform === "win32";
  const command = process.platform === "darwin" ? "open" : win ? "cmd" : "xdg-open";
  try {
    const child = spawn(command, win ? ["/c", "start", "", url] : [url], { detached: true, stdio: "ignore" });
    child.on("error", () => {});
    child.unref();
  } catch {}
}

// Runs the guided setup and returns the exit code. `input` supplies answers (ask, askHidden),
// `open` opens a URL, `io` receives the output.
export async function runSetup({ input, open = () => {}, io = { log: console.log, error: console.error }, cwd = process.cwd() }) {
  try {
    return await guidedSetup({ input, open, io, cwd });
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

async function guidedSetup({ input, open, io, cwd }) {
  const done = (step) => io.log(`✓ ${step}: already done`);
  const dir = agentGhConfigDir(stateDir);
  const user = { cwd, env: { GH_CONFIG_DIR: null } };
  const bot = { cwd, env: { GH_CONFIG_DIR: dir } };

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
  const hosts = readAgentHosts(stateDir);
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
    io.log("Create one at https://github.com/signup, in a private browser window so your own session stays signed in.");
    open("https://github.com/signup");
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

  // 4. The bot's token, stored in the agent directory.
  const tokenOk = botLogin && hosts.loggedIn && hosts.hasToken && await githubClient.login(bot).then((login) => sameLogin(login, botLogin), () => false);
  if (tokenOk) {
    done("Token");
  } else {
    await storeToken({ input, open, io, cwd, dir, botLogin, bot, hadLogin: hosts.loggedIn, renewing });
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
  const protectTarget = { repositoryId, cwd };
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

  // 8. Check everything before agents switch over.
  const report = await readAgentIdentity({ repositoryId, cwd, stateDir, packageEnabled: true });
  const blocking = report.problems.filter((entry) => entry.severity === "problem");
  for (const entry of report.problems.filter((item) => item.severity === "warn")) io.log(`Note: ${entry.message}`);
  if (report.state === "unavailable") stop(`Could not check the result: ${report.reason}. The package stays off.`);
  if (blocking.length > 0) {
    io.error("The bot is not ready, so agents keep acting as you:");
    for (const entry of blocking) io.error(`  - ${entry.message}\n    Fix: ${entry.fix}`);
    return 1;
  }
  io.log("✓ Check: the bot account, its access and the branch protection all look right.");

  // 9. Turn the package on.
  if (agentIdentityPackageEnabled()) {
    done("Package on");
  } else {
    const { enablePackage, PackageMutationError } = await import("./packages.mjs");
    try {
      const result = await enablePackage([AGENT_IDENTITY_PACKAGE_ID]);
      if (!result.ok) stop("The package did not apply cleanly; see the messages above.");
    } catch (error) {
      if (error instanceof PackageMutationError) stop(error.message);
      throw error;
    }
  }
  io.log(`Agents now act on GitHub as ${botLogin}. New agent sessions pick this up.`);
  return 0;
}

async function inviteBot({ user, repo, botLogin, io, done }) {
  if (await githubClient.isCollaborator(user, repo, botLogin).catch(refused("check collaborators"))) {
    done(`Invitation (${botLogin} is a collaborator)`);
    return;
  }
  const invited = (await githubClient.repoInvitations(user, repo)).some((invitation) => invitation.invitee?.login?.toLowerCase() === botLogin.toLowerCase());
  if (invited) {
    io.log(`✓ Invitation: ${botLogin} already has a pending invitation.`);
    return;
  }
  try {
    await githubClient.inviteCollaborator(user, repo, botLogin);
  } catch (error) {
    if (error instanceof GitHubError) stop(`GitHub refused the invitation: ${error.message}. You must be an admin of ${repo}.`);
    throw error;
  }
  io.log(`✓ Invited ${botLogin} to ${repo}.`);
}

function refused(what) {
  return (error) => {
    if (error instanceof GitHubError) stop(`GitHub refused to ${what}: ${error.message}. You must be an admin of the repo.`);
    throw error;
  };
}

async function storeToken({ input, open, io, cwd, dir, botLogin, bot, hadLogin, renewing }) {
  const hosts = readAgentHosts(stateDir);
  if (hadLogin && !hosts.hasToken) {
    io.log("The saved login keeps its token in the keychain, so it is replaced.");
  }
  if (renewing) {
    // Regenerating keeps the token's note and scopes and only issues a new value and expiry.
    io.log(`Sign in as ${botLogin} in a private window, then open https://github.com/settings/tokens.`);
    open("https://github.com/settings/tokens");
    io.log('Open the "RoboRepo agents" token and choose Regenerate token, or make a new classic token with only the repo and read:org scopes.');
  } else {
    io.log(`Sign in as ${botLogin} in the private window, then open https://github.com/settings/tokens/new (a classic token).`);
    open("https://github.com/settings/tokens/new");
    io.log('Note: "RoboRepo agents". Scopes: repo and read:org only (not workflow).');
  }
  io.log(`Expiry: 90 days is a good default. roborepo doctor and roborepo github status warn ${EXPIRING_DAYS} days before it ends; renew by rerunning roborepo github setup.`);
  io.log("Do not paste the token into an agent chat.");
  io.log(`Agents' sandboxes cannot read the keychain, so the token is stored in ${agentHostsFile(stateDir)}.`);
  const token = (await input.askHidden("Paste the token (input hidden): ")).trim();
  if (!token) stop("No token given.");
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  fs.chmodSync(dir, 0o700);
  const env = { GH_CONFIG_DIR: dir };
  try {
    await runGh(cwd, ["auth", "login", "--hostname", "github.com", "--git-protocol", "https", "--with-token", "--insecure-storage"], `${token}\n`, { env });
  } catch (error) {
    const detail = String(error?.stderr || error?.message || "").split(token).join("***").trim();
    stop(`gh could not sign the bot in${detail ? `: ${detail}` : ""}`);
  }
  try {
    fs.chmodSync(agentHostsFile(stateDir), 0o600);
  } catch {}
  const signedInAs = await githubClient.login(bot).catch(() => null);
  if (!signedInAs || !sameLogin(signedInAs, botLogin)) {
    await runGh(cwd, ["auth", "logout", "--hostname", "github.com"], "", { env }).catch(() => {});
    stop(signedInAs
      ? `That token belongs to ${signedInAs}, not ${botLogin}. It was signed out again; rerun with the right token.`
      : "GitHub did not accept that token. It was signed out again; rerun with a new token.");
  }
  io.log(`✓ Token stored; signed in as ${botLogin}.`);
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
