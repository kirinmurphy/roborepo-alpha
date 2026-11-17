// Entry point for Git host calls: takes a host name and returns its client. A host with no client
// resolves to `{ supported: false }`, so callers report it instead of failing.
import { githubClient } from "./github.mjs";

const CLIENTS = new Map([[githubClient.host, githubClient]]);

export function forgeClient(host) {
  return CLIENTS.get(String(host || "").toLowerCase()) ?? { host: host || null, supported: false };
}

// Splits a canonical repository id (`git:<host>/<owner>/<repo>`) into the host and the
// `owner/repo` its client addresses. Null for a `local:` id or anything not shaped like one.
export function forgeTargetForRepositoryId(repositoryId) {
  const match = /^git:([^/]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(String(repositoryId || ""));
  return match ? { host: match[1].toLowerCase(), repo: match[2] } : null;
}

export { GitHubError } from "./github.mjs";
