// `roborepo git <provider> setup`: guided setup of the bot account agents act as on a forge
// provider (GitHub today). Every provider's setup command calls this one module; the steps and their
// order are shared, and what each step does on the host comes from the provider's `agent-identity`
// adapter. Every step checks first and skips itself when already done, so rerunning is safe. It runs
// in the user's own terminal: it reads the bot's token without echo and hands it to the provider's
// CLI on stdin, never through an argument, a file RoboRepo writes, or the output.
import readline from "node:readline";
import { ForgeError, capabilityHostNames, hasForgeCapability, providerForRepositoryId } from "../../modules/forge/index.mjs";
import { readAgentIdentity } from "../../modules/forge/agent-identity.mjs";
import { SetupStop, setupCommand, stopSetup as stop } from "../../modules/forge/agent-identity-findings.mjs";
import { applyProtection, readProtection } from "../../modules/forge/protection.mjs";
import { currentRepositoryId } from "./current-repository.mjs";
import {
  agentGitRoutingGaps, agentIdentityPackageInstalled, agentIdentityPackageState, packageIdentityVariablesText, turnOnAgentIdentityPackage,
} from "./agent-identity-package.mjs";
import { agentIdentityProvider } from "./forge-identity.mjs";
import { stateDir } from "./state-paths.mjs";

const sameLogin = (a, b) => String(a).toLowerCase() === String(b).toLowerCase();

// The CLI entry; `argv` starts with the provider id the command definition prepends. Setup reads a
// token and asks questions, so it only ever runs with a real terminal on both ends; there is no
// switch around that. Tests call `runSetup` with their own input source.
export async function forgeSetupCommand([providerId] = []) {
  const provider = agentIdentityProvider(providerId);
  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    console.error(`${setupCommand(provider)} asks questions and reads a token, so it needs your own terminal. Run it there.`);
    process.exitCode = 1;
    return;
  }
  const input = interactiveInput();
  try {
    process.exitCode = await runSetup({ provider, input });
  } finally {
    input.close();
  }
}

// Runs the guided setup and returns the exit code. `input` supplies answers (ask, askHidden), `io`
// receives the output. The host's pages are printed, never opened: they are done signed in as the
// bot, and the default browser is usually signed in as you. `provider` defaults to the repo's.
export async function runSetup({ provider: named = null, input, io = { log: console.log, error: console.error }, cwd = process.cwd() }) {
  let host = named?.manifest.displayName ?? capabilityHostNames("agent-identity");
  try {
    // 1. The repo, which must be on the provider's hosts.
    const repositoryId = await currentRepositoryId(cwd);
    const found = providerForRepositoryId(repositoryId);
    const provider = named ?? (hasForgeCapability(found?.provider, "agent-identity") ? found.provider : null);
    if (!provider || found?.provider !== provider) stop(`This repo has no ${host} origin, so there is nothing to set up.`);
    host = provider.manifest.displayName;
    return await guidedSetup({ provider, repositoryId, repo: found.repo, input, io, cwd });
  } catch (error) {
    if (error instanceof SetupStop) {
      io.error(error.message);
      return 1;
    }
    if (error instanceof ForgeError) {
      io.error(`${host}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

async function guidedSetup({ provider, repositoryId, repo, input, io, cwd }) {
  const done = (step) => io.log(`✓ ${step}: already done`);
  const host = provider.manifest.displayName;
  const adapter = provider.adapters.agentIdentity;
  const user = { cwd, env: adapter.userEnv() };
  const bot = { cwd, env: adapter.agentEnv(stateDir) };

  // The user's own sign-in.
  let userLogin;
  try {
    userLogin = await adapter.readLogin(user);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    stop(adapter.userSignInRefusal(error));
  }
  io.log(`✓ You are ${userLogin}, setting up ${repo}.`);

  // 2. The bot account.
  let hosts = adapter.readStoredLogin(stateDir);
  let botLogin = null;
  let renewing = false;
  if (hosts.loggedIn) botLogin = await adapter.readLogin(bot).catch(() => null);
  // The host no longer accepts the saved token (it expired or was revoked), but the stored login
  // still names the bot, so this run renews the token instead of walking through creating an account.
  if (!botLogin && hosts.user && !sameLogin(hosts.user, userLogin)) {
    botLogin = await adapter.accountLogin(user, hosts.user);
    renewing = Boolean(botLogin);
  }
  if (renewing) {
    io.log(`✓ Bot account: ${botLogin} (${host} no longer accepts its saved token, so you will paste a new one)`);
  } else if (botLogin) {
    done(`Bot account (${botLogin})`);
  } else {
    for (const line of adapter.createAccountLines()) io.log(line);
    const typed = (await input.ask("Bot account login: ")).trim();
    if (!typed) stop("No bot account login given.");
    if (sameLogin(typed, userLogin)) stop("The bot must be a different account from your own.");
    // The host's own spelling of the login is the one every later comparison uses.
    botLogin = await adapter.accountLogin(user, typed);
    if (!botLogin) stop(`${host} has no account named ${typed}. Create it first, then rerun this.`);
    io.log(`✓ Bot account: ${botLogin}`);
  }
  if (sameLogin(botLogin, userLogin)) stop(`The signed-in bot is your own account. Sign out of it with ${provider.manifest.cli.name} auth logout, then rerun this.`);

  // 3. Invite the bot to the repo, as the user. Only an admin can see or send invitations; the
  // token step that follows is the bot account's own and still worth finishing, and the final check
  // names what the repo's owner has to do here.
  try {
    const invited = await adapter.invite(user, repo, botLogin);
    if (invited.outcome === "collaborator") done(`Invitation (${invited.message})`);
    else io.log(`✓ ${invited.message}`);
  } catch (error) {
    if (!(error instanceof ForgeError)) throw error;
    io.log(`You cannot invite ${botLogin} to ${repo} (${host}: ${error.message}); only a repo admin can. If someone else owns it, the final check prints a message to send them. Continuing with the bot account.`);
  }

  // 4. The bot's token, stored where agents can read it. A working token the CLI keeps elsewhere
  // (the keychain, which agents' sandboxes cannot read) is moved, not asked for again.
  if (hosts.loggedIn && !hosts.hasToken && botLogin && !renewing) {
    await adapter.moveStoredToken({ cwd, stateDir, botLogin, io });
    hosts = adapter.readStoredLogin(stateDir);
  }
  const tokenOk = botLogin && hosts.loggedIn && hosts.hasToken && await adapter.readLogin(bot).then((login) => sameLogin(login, botLogin), () => false);
  // A token that still works may still need replacing: it expires soon, never expires, or has the
  // wrong scopes. Offer it here, so a rerun can renew before agents start failing.
  const tokenIssues = tokenOk ? adapter.accountProblems(await adapter.readAccount(bot)) : [];
  let replace = !tokenOk;
  if (tokenIssues.length > 0) {
    for (const entry of tokenIssues) io.log(`Note: ${entry.message}`);
    const answer = (await input.ask("Replace the bot's token now? [Y/n] ")).trim().toLowerCase();
    replace = answer === "" || answer === "y" || answer === "yes";
  }
  if (replace) {
    await adapter.storeToken({ input, io, cwd, stateDir, botLogin, hadLogin: hosts.loggedIn, renewing: renewing || tokenOk, issues: tokenIssues });
  } else {
    done("Token");
  }

  // 5. The bot accepts the invitation.
  if (await adapter.acceptInvitation(bot, repo)) io.log(`✓ Invitation accepted as ${botLogin}.`);
  else done("Invitation accepted");

  // 6. Branch protection.
  // As you, even from a terminal whose CLI config names another sign-in, like every other user step.
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

  // 7. The files the provider keeps beside the token, refreshed before the check.
  for (const line of adapter.refreshLocalFiles(stateDir)) io.log(line);

  // The bot as the author of agents' commits.
  const author = await adapter.writeAuthor({ user, stateDir, login: botLogin });
  io.log(`✓ commit author: ${author.changed ? `agents' commits in ${provider.manifest.hosts.join(" and ")} repos are now authored by` : "already"} ${author.ident}`);

  // 8. Check everything before agents switch over.
  const report = await readAgentIdentity({ provider, repositoryId, cwd, stateDir, packageEnabled: true });
  const blocking = report.problems.filter((entry) => entry.severity === "problem");
  // A failed check never changes the package, so whatever agents use now they keep using. No
  // refusal names that account: even a clean "off" cannot see a Codex project config or `-c`
  // override that gives agents another one. A package that is on can still leave pushes
  // going out as you (a harness without the bot's Git settings), a partial install may route some
  // calls only, and an unread or deselected-but-leftover state proves nothing.
  const packageState = await agentIdentityPackageState(provider);
  for (const entry of report.problems.filter((item) => item.severity === "warn" || item.severity === "unverified")) io.log(`Note: ${entry.message}`);
  // Setup confirms nothing it could not check: an unread account or branch protection stops here.
  if (report.state === "unavailable") stop(`Could not check the result: ${report.reason}. Setup does not change the package until every check runs.`);
  if (blocking.length > 0) {
    io.error(packageState.state === "off"
      ? `The bot is not ready, so the package stays off and agents keep the ${host} sign-in they had before setup:`
      : `The bot is not ready. ${packageKept(provider, packageState)} Agents using the bot may fail on ${host} until this is fixed; ${stopUsingBot(provider, packageState)}:`);
    for (const entry of blocking) io.error(`  - ${entry.message}\n    Fix: ${entry.fix}`);
    if (report.ownerMessage) io.error(`\nMessage for the repo's owner:\n${report.ownerMessage}`);
    return 1;
  }
  // Rules that apply but whose bypass list could not be read may let the bot merge unreviewed work,
  // so the package stays off until someone who can see them confirms them.
  if (report.state === "unverified") {
    io.error(packageState.state === "off"
      ? `The branch rules could not be verified, so the package stays off and agents keep the ${host} sign-in they had before setup.`
      : `The branch rules could not be verified. ${packageKept(provider, packageState)} Confirm the rules, or ${stopUsingBot(provider, packageState)}.`);
    for (const entry of report.problems.filter((item) => item.severity === "unverified")) io.error(`  - ${entry.message}\n    Fix: ${entry.fix}`);
    if (report.ownerMessage) io.error(`\nMessage for the repo's owner:\n${report.ownerMessage}`);
    return 1;
  }
  io.log("✓ Check: the bot account, its access and the branch protection all look right.");

  // 9. Turn the package on. Enabling again re-applies every resource, which repairs one left
  // missing when an earlier enable failed partway; that includes the pair that makes each harness's
  // agent shells include the bot's Git settings. A harness whose config is missing still pushes as
  // the user, and `roborepo update` writes it, so setup stops there rather than report success.
  const gapsBefore = agentGitRoutingGaps(provider);
  if (await agentIdentityPackageInstalled(provider)) {
    if (gapsBefore.length === 0) done("Package on");
  } else {
    const turnedOn = await turnOnAgentIdentityPackage(provider);
    if (!turnedOn.ok) stop(`${turnedOn.message} Agents may not act as ${botLogin}; see the messages above.`);
  }
  const gaps = agentGitRoutingGaps(provider);
  if (gaps.length > 0) {
    stop(`The package is on, but your ${gaps.join(" and ")} settings don't include the bot's Git settings yet, so agents' git pushes still go out as you. Run roborepo update, then rerun this.`);
  }
  io.log(`Agents now act on ${host} as ${botLogin}. New agent sessions pick this up.`);
  return 0;
}

// What a refusal says about the package it leaves as it was, and how to stop agents using the bot.
// Only a verified clean "off" names an identity; every other state says what it found instead.
function packageKept(provider, { state, harnesses = [] }) {
  const host = provider.manifest.displayName;
  if (state === "on") return "The package is on and stays on.";
  if (state === "partial") return `The package is partly installed and stays as it is, so agents may use the bot for some ${host} calls and not others.`;
  if (state === "leftover") return `The package is off, but your ${harnesses.join(" and ")} settings still set ${packageIdentityVariablesText(provider)}, or include the bot's Git settings, so setup cannot tell which ${host} account agents use. Setup changes nothing.`;
  return `Setup could not read whether the package is on, or what your harness settings give agents, so it cannot tell which ${host} account agents use. Setup changes nothing.`;
}
// The way to stop agents using the bot that fits the state: turning the package off does nothing
// once it is already off, so leftover settings are removed by hand.
function stopUsingBot(provider, { state, harnesses = [] }) {
  const { packageId } = provider.manifest.agent;
  if (state === "leftover") return `to stop agents using them meanwhile, remove those entries from your ${harnesses.join(" and ")} settings`;
  if (state === "unknown") return `check \`roborepo package status ${packageId}\` and your harness settings first`;
  return `to stop agents using the bot meanwhile, turn it off in Settings or run roborepo package disable ${packageId}`;
}

// Exported for tests, which pass their own streams.
export function interactiveInput({ stdin = process.stdin, stdout = process.stdout } = {}) {
  return {
    ask(question) {
      const rl = readline.createInterface({ input: stdin, output: stdout });
      return new Promise((resolve, reject) => {
        let answered = false;
        // Ctrl+D at an empty prompt closes the interface without an answer: that is a cancel.
        rl.on("close", () => { if (!answered) reject(new SetupStop("Cancelled.")); });
        rl.question(question, (answer) => { answered = true; rl.close(); resolve(answer); });
      });
    },
    askHidden(question) {
      stdout.write(question);
      return new Promise((resolve, reject) => {
        let text = "";
        const finish = (fn) => {
          stdin.setRawMode(false);
          stdin.pause();
          stdin.removeListener("data", onData);
          stdout.write("\n");
          fn();
        };
        const onData = (chunk) => {
          for (const char of chunk.toString("utf8")) {
            if (char === "\r" || char === "\n") return finish(() => resolve(text));
            if (char === "\u0003") return finish(() => reject(new SetupStop("Cancelled.")));
            if (char === "\u007f" || char === "\b") text = text.slice(0, -1);
            else text += char;
          }
        };
        stdin.setRawMode(true);
        stdin.resume();
        stdin.on("data", onData);
      });
    },
    close() {},
  };
}
