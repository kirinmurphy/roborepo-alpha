// A test-only forge provider for `forge.example.test`: an agent account but no branch protection
// or pull requests, so checks can show that shared code reads the provider it is given rather than
// GitHub, and reports a missing capability instead of failing. It never ships: tests pass it to the
// registry's lookups through their `providers` option. Nothing here reaches a network; the account
// is always "not set up".
import path from "node:path";
import { defineForgeProvider } from "../../../../modules/forge/contract.mjs";

export const fakeManifest = Object.freeze({
  id: "fake-forge",
  displayName: "Fake Forge",
  hosts: ["forge.example.test"],
  cli: {
    name: "fakecli",
    configSubfolder: "cli",
    configDirVariable: "FAKE_FORGE_CONFIG_DIR",
    tokenVariables: ["FAKE_FORGE_TOKEN"],
    identityVariables: ["FAKE_FORGE_CONFIG_DIR", "FAKE_FORGE_TOKEN"],
  },
  agent: {
    packageId: "fake-forge-agent-identity",
    stateFolder: "fake-forge-agent",
    commandNamespace: "fake-forge",
    networkDomains: ["forge.example.test"],
  },
  capabilities: ["repository", "agent-identity"],
});

const unused = (name) => () => { throw new Error(`the fake forge provider does not implement ${name}`); };
const configDir = (stateDir) => path.join(stateDir, fakeManifest.agent.stateFolder, fakeManifest.cli.configSubfolder);

export const fakeAgentIdentity = {
  readStoredLogin: () => ({ loggedIn: false, hasToken: false, user: null }),
  credentialsFile: (stateDir) => path.join(configDir(stateDir), "credentials"),
  agentEnv: (stateDir) => ({ FAKE_FORGE_CONFIG_DIR: configDir(stateDir), FAKE_FORGE_TOKEN: null }),
  userEnv: () => ({ FAKE_FORGE_CONFIG_DIR: null }),
  readAccount: unused("readAccount"),
  readLogin: unused("readLogin"),
  accountProblems: () => [],
  readRepoAccess: async () => [],
  localFileProblems: () => [],
  authorIdentity: ({ login }) => `${login}@forge.example.test`,
  ownerMessage: ({ botLogin, repo }) => `Invite ${botLogin} to ${repo}.`,
  guide: () => ({ command: "roborepo git fake-forge setup", lead: "", steps: [] }),
  accountLogin: unused("accountLogin"),
  accountId: unused("accountId"),
  invite: unused("invite"),
  acceptInvitation: unused("acceptInvitation"),
  storeToken: unused("storeToken"),
  installToken: unused("installToken"),
  moveStoredToken: unused("moveStoredToken"),
  refreshLocalFiles: () => [],
  writeAuthor: unused("writeAuthor"),
  createAccountLines: () => [],
  userSignInRefusal: (error) => error.message,
  userSignInCheck: "fakecli auth status",
  setupOnlyWarnings: new Set(),
};

export const fakeRepository = {
  parseRemote(url) {
    const match = /^https:\/\/forge\.example\.test\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+?)(?:\.git)?$/.exec(String(url ?? ""));
    return match ? { host: "forge.example.test", repo: match[1].toLowerCase() } : null;
  },
  repository: unused("repository"),
};

// `adapters` replaces adapter groups, so a check can build a provider that lacks a method.
export function makeFakeProvider({ manifest = fakeManifest, adapters = {} } = {}) {
  return defineForgeProvider({
    manifest,
    adapters: { repository: fakeRepository, agentIdentity: fakeAgentIdentity, ...adapters },
  });
}

export const fakeProvider = makeFakeProvider();
