// The portal's view of each forge provider's bot identity (GitHub today). A provider's bot account
// is one for every repo on its hosts, so it is read once; each listed repo on those hosts adds only
// what is about that repo (the bot's invitation and access there, and the branch rules). While the
// package is off, Home offers the setup; its "No thanks" is remembered here. The portal reads
// status, opens `roborepo git <provider> setup` in a terminal, and can turn the package on when that
// is the only step left; the token is typed at the setup's hidden prompt, so it never passes through
// the browser or this server. Every account call takes a provider id (default: the first provider
// with an agent account), and every answer names its provider.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { listForgeProviders } from "../../modules/forge/index.mjs";
import { packageIsOnlyStep } from "../../modules/forge/agent-identity.mjs";
import { loadRegistry } from "../../modules/repositories/registry.mjs";
import { agentIdentityProviders, turnOnAgentIdentityPackage } from "./agent-identity-package.mjs";
import { applyHarnessConfig } from "./portal-harness-refresh.mjs";
import {
  agentIdentityProvider, inviteBotToRepo, readCurrentAccountIdentity, readCurrentRepoAgentAccess, readLocalAccountFacts, repoAgentIdentityProvider,
} from "./forge-identity.mjs";
import { STATE_ROOT } from "./paths.mjs";
import { selectPrimaryCheckout } from "./repository-agent-config.mjs";
import { loadRepositoryPayload } from "./repositories.mjs";
import { launchInTerminal, terminalLaunchSupported } from "./terminal-launch.mjs";

// Per host call, as for branch protection: a slow read reports `unavailable` instead of holding Home.
const PORTAL_TIMEOUT_MS = 8000;
// An uncached read makes several gh calls, and Home lists every repo and polls, so GitHub's answers
// are reused for a while. What this machine alone decides (the package, the agents' Git settings,
// the bot's sign-in file) is re-read on every request instead, and a change there drops the reuse,
// so `roborepo package disable` shows on Home's next poll. `fresh` skips the cache outright: the
// page asks for it when the user returns from the setup.
const CACHE_MS = 5 * 60_000;
const MAIN_SCRIPT = fileURLToPath(new URL("./main.mjs", import.meta.url));

// A folder gh can start in for reads that name the repo or need none: the home folder, or the
// temporary folder where there is no home folder (a missing working folder fails the spawn).
const neutralFolder = () => (fs.existsSync(os.homedir()) ? os.homedir() : os.tmpdir());

const repoCache = new Map();
// Per provider id: { at, key, report }, { key, promise }, and the read count below.
const accountCaches = new Map();
const accountPendings = new Map();
// Each read that starts counts up, and only the latest read started may write its cache: a fresh read
// can start while an older one is pending, and the older one finishing last must not replace it.
// Clearing the cache counts up too, so a read started before the clear never refills it.
const accountReadCounts = new Map();
const repoReadCounts = new Map();
let repoGeneration = 0;

// The provider an account call names; an unknown id is a bad request, never a guess. `providers`
// replaces the shipped list (tests).
function accountProvider(providerId, providers) {
  if (providerId === undefined || providerId === null || providerId === "") {
    const [first] = agentIdentityProviders({ providers });
    if (!first) throw Object.assign(new Error("no forge provider has an agent account"), { code: "NOT_FOUND" });
    return first;
  }
  try {
    return agentIdentityProvider(providerId, providers ? { providers } : {});
  } catch (error) {
    throw Object.assign(error, { code: "BAD_REQUEST" });
  }
}

// What the browser needs to know about every provider, before any account is read: which repos a
// provider's card applies to, its name for labels, and the package its Settings row switches.
export function listPortalForgeProviders({ providers } = {}) {
  return listForgeProviders(providers ? { providers } : {}).map((provider) => ({
    id: provider.id,
    displayName: provider.manifest.displayName,
    hosts: [...provider.manifest.hosts],
    capabilities: [...provider.manifest.capabilities],
    packageId: provider.manifest.agent?.packageId ?? null,
  }));
}

const providerSummary = (provider) => ({ id: provider.id, displayName: provider.manifest.displayName });

// One provider's bot account, shared by every repo on its hosts. Concurrent callers (Home reads
// every repo card at once) share one read. A cached or pending read is reused only while the local
// facts it was made with still hold.
async function readAccount({ provider, fresh, now, read, readLocal = readLocalAccountFacts }) {
  const id = provider.id;
  const local = readLocal(provider);
  const key = JSON.stringify(local);
  const cached = accountCaches.get(id);
  const pendingRead = accountPendings.get(id);
  if (!fresh && cached?.key === key && now() - cached.at < CACHE_MS) return cached.report;
  if (!fresh && pendingRead?.key === key) return pendingRead.promise;
  const started = (accountReadCounts.get(id) ?? 0) + 1;
  accountReadCounts.set(id, started);
  const promise = read({ provider, cwd: neutralFolder(), timeoutMs: PORTAL_TIMEOUT_MS, local }).then((report) => {
    if (started === accountReadCounts.get(id)) accountCaches.set(id, { at: now(), key, report });
    return report;
  }).finally(() => { if (accountPendings.get(id)?.promise === promise) accountPendings.delete(id); });
  accountPendings.set(id, { key, promise });
  return promise;
}

export async function loadAgentIdentityAccount({
  providerId, fresh = false, stateRoot = STATE_ROOT, platform = process.platform, now = Date.now, read = readCurrentAccountIdentity, readLocal, providers,
} = {}) {
  const provider = accountProvider(providerId, providers);
  return { ...portalAccount(provider, await readAccount({ provider, fresh, now, read, readLocal }), { platform }), offerDismissed: offerDismissed(stateRoot) };
}

// "No thanks" to Home's setup offer. A marker file in RoboRepo's state, not in the bot's folder:
// it is a portal preference, and the bot's folder is written only by the setup.
const offerMarker = (stateRoot) => path.join(stateRoot, "agent-identity", "offer-dismissed");
const offerDismissed = (stateRoot) => fs.existsSync(offerMarker(stateRoot));

export function dismissAgentIdentityOffer({ stateRoot = STATE_ROOT, now = () => new Date() } = {}) {
  const marker = offerMarker(stateRoot);
  fs.mkdirSync(path.dirname(marker), { recursive: true });
  fs.writeFileSync(marker, `${now().toISOString()}\n`);
  return { offerDismissed: true };
}

// Resolves to `{ applies: false }` for a repo whose host has no provider with an agent account,
// so the card stays hidden there, and to `account: "waiting"` while the bot account cannot be used (not set up, or
// its token is not accepted): the account is what to fix, and there is nothing per repo to check.
// Rejects with NOT_FOUND for an id the portal does not list.
export async function loadRepositoryAgentIdentity({
  repositoryId, stateRoot, fresh = false, platform = process.platform, now = Date.now,
  readAccountReport = readCurrentAccountIdentity, read = readCurrentRepoAgentAccess, readLocal, providers,
}) {
  const { checkout } = repositoryTarget({ repositoryId, stateRoot });
  const provider = repoAgentIdentityProvider(repositoryId, providers ? { providers } : {});
  if (!provider) return { repositoryId, applies: false };
  const account = await readAccount({ provider, fresh, now, read: readAccountReport, readLocal });
  const setupLaunch = launchInfo({ checkout, platform });
  if (!accountReady(account)) return { repositoryId, applies: true, provider: providerSummary(provider), account: "waiting", state: null, findings: [], setupLaunch };
  const cached = repoCache.get(repositoryId);
  let report;
  if (!fresh && cached && now() - cached.at < CACHE_MS && cached.botLogin === account.botLogin) report = cached.report;
  else {
    const started = (repoReadCounts.get(repositoryId) ?? 0) + 1;
    const generation = repoGeneration;
    repoReadCounts.set(repositoryId, started);
    // The checkout only matters to the gh calls as a working folder; the repo itself is named.
    report = await read({ provider, repositoryId, cwd: checkout.ok ? checkout.path : neutralFolder(), timeoutMs: PORTAL_TIMEOUT_MS, botLogin: account.botLogin });
    if (repoReadCounts.get(repositoryId) === started && repoGeneration === generation) repoCache.set(repositoryId, { at: now(), report, botLogin: account.botLogin });
  }
  return {
    repositoryId,
    applies: true,
    provider: providerSummary(provider),
    account: "ready",
    state: report.state,
    repository: report.repository,
    botLogin: report.botLogin,
    userAdmin: report.userAdmin,
    reason: report.reason,
    findings: portalFindings(report.problems),
    ownerMessage: report.ownerMessage,
    setupLaunch,
  };
}

// Turns the package on from the portal, only when that is the one step left (the account read
// afresh shows a working bot and nothing else to fix), which is what the setup's last step does.
// Anything more goes through the provider's setup command in a terminal.
export async function turnOnAgentIdentity({
  providerId, platform = process.platform, now = Date.now, read = readCurrentAccountIdentity, turnOn = turnOnAgentIdentityPackage,
} = {}) {
  const provider = accountProvider(providerId);
  const view = (report) => portalAccount(provider, report, { platform });
  const before = await readAccount({ provider, fresh: true, now, read });
  if (before.packageEnabled) return { enabled: true, account: view(before) };
  if (!packageIsOnlyStep(provider, before)) {
    return { enabled: false, reason: "not_ready", message: "The bot account needs more than the package turned on; open the setup instead.", account: view(before) };
  }
  const result = await turnOn(provider);
  clearRepoCache();
  const after = await readAccount({ provider, fresh: true, now, read });
  if (!result.ok) return { enabled: false, reason: "enable_failed", message: result.message, account: view(after) };
  return { enabled: true, account: view(after) };
}

// "Update now" for agents whose git pushes still go out as the user: applies RoboRepo's config (the
// install step `roborepo update` runs), which writes the bot's Git settings into Claude Code's and
// Codex's settings. Runs only while a fresh read still shows that gap; the page sends nothing else.
export async function applyAgentGitRouting({
  providerId, platform = process.platform, now = Date.now, read = readCurrentAccountIdentity, apply = applyHarnessConfig,
} = {}) {
  const provider = accountProvider(providerId);
  const view = (report) => portalAccount(provider, report, { platform });
  const before = await readAccount({ provider, fresh: true, now, read });
  if (!before.problems.some((entry) => entry.id === "git-not-routed")) return { applied: false, reason: "not_needed", account: view(before) };
  const result = await apply();
  clearRepoCache();
  const after = await readAccount({ provider, fresh: true, now, read });
  if (!result.ok) return { applied: false, reason: "apply_failed", message: `The update did not finish: ${result.error}`, account: view(after) };
  return { applied: true, account: view(after) };
}

// "Invite the bot" on a repo's card: invites it as the user and accepts as the bot, with no terminal.
// Needs a bot that works; answers with the repo read afresh, so the card shows the result.
export async function inviteAgentBot({
  repositoryId, stateRoot, platform = process.platform, now = Date.now,
  readAccountReport = readCurrentAccountIdentity, read = readCurrentRepoAgentAccess, invite = inviteBotToRepo,
}) {
  repositoryTarget({ repositoryId, stateRoot });
  const provider = repoAgentIdentityProvider(repositoryId);
  if (!provider) return { invited: false, reason: "unsupported_host", message: "This repo's host has no agent account." };
  const account = await readAccount({ provider, fresh: false, now, read: readAccountReport });
  if (!accountReady(account)) return { invited: false, reason: "not_ready", message: "The bot account needs fixing first." };
  const result = await invite({ repositoryId, cwd: neutralFolder(), timeoutMs: PORTAL_TIMEOUT_MS, botLogin: account.botLogin });
  repoCache.delete(repositoryId);
  repoReadCounts.set(repositoryId, (repoReadCounts.get(repositoryId) ?? 0) + 1);
  const repository = await loadRepositoryAgentIdentity({ repositoryId, stateRoot, fresh: true, platform, now, readAccountReport, read });
  return result.ok ? { invited: true, repository } : { invited: false, reason: "refused", message: result.message, repository };
}

// Opens `roborepo git <provider> setup` in a new terminal, in the repo's primary checkout, after the user
// clicks for it. Nothing from the browser reaches the command: the program, its arguments, and the
// folder are all chosen here. Every outcome the user can act on is a result with a `reason`, so the
// page can show the command to copy instead.
export async function launchAgentIdentitySetup({
  repositoryId, stateRoot, platform = process.platform, launch = launchInTerminal, executable = process.execPath, mainScript = MAIN_SCRIPT,
}) {
  const { checkout } = repositoryTarget({ repositoryId, stateRoot });
  const provider = repoAgentIdentityProvider(repositoryId);
  if (!provider) return { launched: false, reason: "unsupported_host" };
  if (!terminalLaunchSupported(platform)) return { launched: false, reason: "unsupported_platform" };
  if (!checkout.ok) return { launched: false, reason: "no_checkout", error: checkout.message };
  const result = launch({
    name: `${provider.id}-setup-${repositoryId.replace(/[^A-Za-z0-9]+/g, "-")}`,
    executable,
    args: [mainScript, "git", provider.manifest.agent.commandNamespace, "setup"],
    cwd: checkout.path,
    closeOnSuccess: true,
  }, { platform });
  // Whatever the setup does next, the cached status no longer describes it.
  clearAgentIdentityCache();
  if (!result.ok) return { launched: false, reason: result.reason, error: result.error ?? null };
  return { launched: true };
}

export function clearAgentIdentityCache() {
  clearRepoCache();
  accountCaches.clear();
  accountPendings.clear();
  for (const [id, count] of accountReadCounts) accountReadCounts.set(id, count + 1);
}

// Drops every repo's cached report, and stops any repo read still pending from writing the cache.
function clearRepoCache() {
  repoCache.clear();
  repoGeneration += 1;
}

// A bot the host says is your own account is not one agents can use: reading or inviting for it would
// report your access.
const accountReady = (account) => Boolean(account.botLogin) && account.state !== "not-set-up"
  && !(account.state === "unavailable" && account.problems.length === 0)
  && !account.problems.some((entry) => entry.id === "bot-is-user");

// Throws NOT_FOUND for an id the portal does not list, so the routes act only on known repos.
function repositoryTarget({ repositoryId, stateRoot = STATE_ROOT }) {
  loadRepositoryPayload({ repositoryId, stateRoot });
  return { checkout: selectPrimaryCheckout(loadRegistry({ stateRoot }), repositoryId) };
}

function launchInfo({ checkout, platform }) {
  return { supported: terminalLaunchSupported(platform) && checkout.ok, ...(checkout.ok ? {} : { reason: checkout.message }) };
}

// Named fields only: the reports hold no token, and listing them keeps it that way if they grow.
const portalFindings = (problems = []) => problems.map(({ id, severity, message, fix, owner }) => ({ id, severity, message, fix, owner: owner === true }));

function portalAccount(provider, report, { platform }) {
  return {
    provider: providerSummary(provider),
    state: report.state,
    botLogin: report.botLogin,
    savedLogin: report.savedLogin,
    signedIn: report.signedIn,
    packageEnabled: report.packageEnabled,
    expiresAt: report.expiresAt,
    scopes: report.scopes,
    reason: report.reason,
    findings: portalFindings(report.problems),
    enableOffered: packageIsOnlyStep(provider, report),
    setupLaunch: { supported: terminalLaunchSupported(platform) },
    guide: provider.adapters.agentIdentity.guide(),
  };
}
