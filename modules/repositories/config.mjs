// Tunable tables for repository identity, separated from the logic that consumes them. These are
// product/config values (confidence policy, recognized hosts, write-debounce) rather than algorithm
// — collected here so they can be adjusted in one place without touching process code.
//
// Kept as module constants rather than a manifest JSON on purpose: modules/repositories is a pure
// domain module with no filesystem/path dependency (see the developer-runtime/plan-suite module split), so
// it must not read manifests at import time. This file IS the single source of truth; if a future
// need arises to tune these at runtime, load a manifest in the CLI bridge and pass overrides in.

// Evidence → confidence → auto-association policy (doc §"Confidence and Evidence"). Whether a piece
// of evidence may automatically associate a record with a repository, or merely power a suggestion.
// Name-only and prompt-text evidence NEVER auto-associate.
export const EVIDENCE_POLICY = {
  "git-remote": { confidence: "high", autoAssociate: true },
  "user-alias": { confidence: "high", autoAssociate: true },
  "git-root-hash": { confidence: "high", autoAssociate: true },
  "cwd-in-git-root": { confidence: "high", autoAssociate: true },
  "aliased-path": { confidence: "high", autoAssociate: true },
  "worktree-commondir": { confidence: "high", autoAssociate: true },
  // A git root with no usable remote: resolvable on THIS machine but not portable, so medium — and
  // it may still auto-associate locally (it is a real, distinct repository, just remote-less).
  "path-root": { confidence: "medium", autoAssociate: true },
  "process-cwd": { confidence: "medium", autoAssociate: false },
  "name-match": { confidence: "low", autoAssociate: false },
  "prompt-text": { confidence: "suggestion", autoAssociate: false },
};

// Hosts we emit a browser provider URL for. Others get null (we don't assume their web layout).
export const KNOWN_PROVIDER_HOSTS = new Set(["github.com", "gitlab.com", "bitbucket.org", "codeberg.org"]);

// Don't rewrite lastSeenAt more often than this — avoids churning the registry (and its backups) on
// every process-discovery refresh when nothing else changed (doc §Performance).
export const LAST_SEEN_DEBOUNCE_MS = 60_000;
