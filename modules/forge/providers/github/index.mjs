// The GitHub forge provider: the first and only shipped one. Everything RoboRepo knows about
// GitHub (gh, its API, its pages, its token, its Git config) lives in this folder; the rest of
// RoboRepo reaches it through modules/forge/registry.mjs.
import { defineForgeProvider } from "../../contract.mjs";
import { githubAgentIdentity } from "./agent-identity.mjs";
import { githubClient } from "./client.mjs";
import { githubManifest } from "./manifest.mjs";
import { MANUAL_STEPS, applyProtection, readProtection } from "./protection.mjs";
import { githubPullRequests, githubRepository } from "./pull-requests.mjs";

export const githubProvider = defineForgeProvider({
  manifest: githubManifest,
  client: githubClient,
  adapters: {
    repository: githubRepository,
    agentIdentity: githubAgentIdentity,
    branchProtection: { readProtection, applyProtection, manualSteps: MANUAL_STEPS },
    pullRequests: githubPullRequests,
  },
});
