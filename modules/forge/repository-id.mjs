// Splits a canonical repository id (`git:<host>/<owner>/<repo>`) into the host and the
// `owner/repo` its provider addresses. Null for a `local:` id or anything not shaped like one. Kept
// apart from the registry so a provider can use it without importing the registry that loads it.
export function forgeTargetForRepositoryId(repositoryId) {
  const match = /^git:([^/]+)\/([A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+)$/.exec(String(repositoryId || ""));
  return match ? { host: match[1].toLowerCase(), repo: match[2] } : null;
}
