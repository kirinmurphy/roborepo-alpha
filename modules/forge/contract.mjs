// Capability vocabulary and manifest validation shared by every forge provider (a Git host with an
// API: GitHub today). Modeled on the harness provider contract (scripts/harnesses/contract.mjs):
// a provider declares data in its manifest and the capabilities it implements, and each capability
// names the adapter group and methods it must supply. A provider missing one is refused at load,
// rather than failing when a caller first reaches the method.

export const FORGE_CAPABILITIES = Object.freeze(["repository", "agent-identity", "branch-protection", "pull-requests"]);

export const FORGE_CAPABILITY_REQUIRED_METHODS = Object.freeze({
  // parseRemote(url) -> { host, repo } for a remote URL on one of the provider's hosts, else null.
  // repository(context, repo) -> the host's record of the repo.
  repository: { group: "repository", methods: ["parseRemote", "repository"] },
  // The bot account agents act as on this provider, and the guided setup that creates it.
  "agent-identity": {
    group: "agentIdentity",
    methods: [
      // Reading (status, doctor, portal).
      "readStoredLogin", "credentialsFile", "agentEnv", "userEnv", "readAccount", "readLogin", "accountProblems",
      "readRepoAccess", "localFileProblems", "authorIdentity", "ownerMessage", "guide",
      // Setup.
      "accountLogin", "accountId", "invite", "acceptInvitation", "storeToken", "installToken", "moveStoredToken",
      "refreshLocalFiles", "writeAuthor", "createAccountLines", "userSignInRefusal",
    ],
  },
  "branch-protection": { group: "branchProtection", methods: ["readProtection", "applyProtection"] },
  // readProtection(target) and applyProtection(target, { action }) resolve to the report shape in
  // protection-report.mjs; `manualSteps` (data) lists what a person sets up by hand.
  // Pull request calls take `repo` as `<host>/<owner>/<name>`. Pull requests and check runs keep
  // gh's field names as the shared shape: { number, headRefName, headRefOid, baseRefName,
  // isCrossRepository, state ("OPEN"), url } and { id, headBranch, headSha, status, conclusion, url }.
  "pull-requests": {
    group: "pullRequests",
    methods: ["repositoryUrl", "pullRequestUrl", "checkRunUrl", "repositoryInfo", "findPullRequests", "checkRun", "editBody", "markReady", "rerunFailedChecks"],
  },
});

const ID_PATTERN = /^[a-z][a-z0-9-]*$/;
const HOST_PATTERN = /^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/;
const ENV_NAME_PATTERN = /^[A-Z][A-Z0-9_]*$/;

const nonEmptyString = (value) => typeof value === "string" && value.trim() !== "";
const isObject = (value) => typeof value === "object" && value !== null && !Array.isArray(value);

function stringList(errors, label, value, pattern) {
  if (!Array.isArray(value) || value.length === 0) {
    errors.push(`${label} must be a non-empty array`);
    return;
  }
  for (const entry of value) {
    if (!nonEmptyString(entry) || (pattern && !pattern.test(entry))) errors.push(`${label} has an invalid entry: ${JSON.stringify(entry)}`);
  }
}

// Structural checks only. Returns the list of problems; empty means valid.
export function validateForgeManifest(manifest) {
  const errors = [];
  if (!isObject(manifest)) return ["manifest must be an object"];
  if (!nonEmptyString(manifest.id) || !ID_PATTERN.test(manifest.id)) errors.push("id must be a lowercase identifier");
  if (!nonEmptyString(manifest.displayName)) errors.push("displayName must be a non-empty string");
  stringList(errors, "hosts", manifest.hosts, HOST_PATTERN);
  if (!Array.isArray(manifest.capabilities)) {
    errors.push("capabilities must be an array");
  } else {
    for (const capability of manifest.capabilities) {
      if (!FORGE_CAPABILITIES.includes(capability)) errors.push(`unknown capability: ${capability}`);
    }
  }
  const capabilities = Array.isArray(manifest.capabilities) ? manifest.capabilities : [];
  if (capabilities.includes("agent-identity")) {
    if (!isObject(manifest.cli)) {
      errors.push("cli must be an object when agent-identity is declared");
    } else {
      if (!nonEmptyString(manifest.cli.name)) errors.push("cli.name must be a non-empty string");
      if (!nonEmptyString(manifest.cli.configSubfolder)) errors.push("cli.configSubfolder must be a non-empty string");
      stringList(errors, "cli.identityVariables", manifest.cli.identityVariables, ENV_NAME_PATTERN);
      // The variable that points the CLI at the bot's config folder, and the token variables that
      // outrank it: the ones the identity package sets for agents (the folder) and clears (tokens).
      const identity = new Set(manifest.cli.identityVariables || []);
      if (!identity.has(manifest.cli.configDirVariable)) errors.push("cli.configDirVariable must be one of cli.identityVariables");
      stringList(errors, "cli.tokenVariables", manifest.cli.tokenVariables, ENV_NAME_PATTERN);
      for (const name of manifest.cli.tokenVariables || []) {
        if (!identity.has(name)) errors.push(`cli.tokenVariables entry ${name} must be one of cli.identityVariables`);
      }
    }
    const agent = manifest.agent;
    if (!isObject(agent)) {
      errors.push("agent must be an object when agent-identity is declared");
    } else {
      for (const key of ["packageId", "stateFolder", "commandNamespace"]) {
        if (!nonEmptyString(agent[key]) || !ID_PATTERN.test(agent[key])) errors.push(`agent.${key} must be a lowercase identifier`);
      }
      stringList(errors, "agent.networkDomains", agent.networkDomains, HOST_PATTERN);
    }
  }
  return errors;
}

export function validateForgeAdapters(capabilities, adapters) {
  const errors = [];
  for (const capability of capabilities) {
    const requirement = FORGE_CAPABILITY_REQUIRED_METHODS[capability];
    if (!requirement) continue;
    const group = adapters?.[requirement.group];
    if (!isObject(group)) {
      errors.push(`capability "${capability}" requires adapters.${requirement.group} to be an object`);
      continue;
    }
    for (const method of requirement.methods) {
      if (typeof group[method] !== "function") errors.push(`capability "${capability}" requires adapters.${requirement.group}.${method} to be a function`);
    }
  }
  return errors;
}

// The one constructor every provider goes through, so an incomplete provider never loads.
export function defineForgeProvider({ manifest, adapters, client = null }) {
  const errors = [...validateForgeManifest(manifest), ...validateForgeAdapters(manifest?.capabilities || [], adapters)];
  if (errors.length > 0) throw new Error(`invalid forge provider ${manifest?.id ?? "(no id)"}:\n  ${errors.join("\n  ")}`);
  return Object.freeze({ id: manifest.id, manifest, adapters, client });
}

export const hasForgeCapability = (provider, capability) => Boolean(provider?.manifest.capabilities.includes(capability));
