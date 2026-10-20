// Cross-poll cache for git context read from a checkout that has nothing running in it.
//
// This deliberately does what scan-cache.mjs refuses to do — outlive a scan — so the constraint that
// module states has to be answered rather than ignored: a process-lifetime cache would pin the first
// branch/dirty reading a long-lived portal ever took and report it forever.
//
// The answer is that nothing is cached by root alone. Every entry carries a fingerprint of the
// checkout's git directory, and a hit requires the fingerprint to still match. Commit, checkout,
// branch switch, stage, stash — each writes inside .git and moves the fingerprint, so the next poll
// re-reads. A cache that cannot go stale without the underlying directory changing is not the
// forever-cache that comment warns about.
//
// Why it exists at all: an `idle` repository has no listener to hang git context off, so git context
// is read from the persisted checkout path instead. Doing that uncached costs one `git` subprocess
// per idle repository per poll — at a ~10s poll and a dozen idle repositories, a dozen subprocesses
// every tick, forever, for data that changes when the user commits and not otherwise. Active
// repositories are unaffected: they keep using the per-scan cache.
//
// Fingerprint is deliberately cheap: mtimes of the files git actually rewrites, not a content hash
// and not a `git status`. It can only produce a FALSE MISS (an extra read), never a false hit,
// because every state change this cache cares about touches one of them.

import fs from "node:fs";
import path from "node:path";

// HEAD moves on checkout/commit; index on stage/unstage and on most status-affecting operations;
// packed-refs on fetch/gc. The directory's own mtime catches loose-ref writes that miss all three.
const FINGERPRINT_TARGETS = ["", "HEAD", "index", "packed-refs"];

export function createIdleGitCache({ fsApi = fs, pathApi = path } = {}) {
  const entries = new Map();

  return {
    // Returns the cached context when the checkout has not changed since it was read, otherwise
    // calls readFn and stores the result against the current fingerprint.
    //
    // An unreadable or non-git path yields a null fingerprint and is never cached: a checkout on an
    // unplugged drive must not answer from a reading taken while it was still mounted, which is the
    // same discipline deriveLifecycle applies when it refuses to treat "cannot look" as absence.
    async get(rootPath, gitDir, readFn) {
      if (!rootPath || typeof rootPath !== "string") return readFn();
      const fingerprint = fingerprintOf(gitDir, { fsApi, pathApi });
      if (!fingerprint) {
        entries.delete(rootPath);
        return readFn();
      }
      const hit = entries.get(rootPath);
      if (hit && hit.fingerprint === fingerprint) return hit.value;
      const value = await readFn();
      entries.set(rootPath, { fingerprint, value });
      return value;
    },

    // Drops entries for checkouts no longer under consideration, so a machine that has seen many
    // repositories over a long portal session does not accumulate them without bound.
    retain(rootPaths) {
      const keep = new Set(rootPaths || []);
      for (const key of [...entries.keys()]) {
        if (!keep.has(key)) entries.delete(key);
      }
    },

    get size() {
      return entries.size;
    },
  };
}

// Null when the git directory cannot be read at all — the caller treats that as "do not cache"
// rather than as a distinct state, since an unreadable checkout is not evidence of anything.
function fingerprintOf(gitDir, { fsApi, pathApi }) {
  if (!gitDir || typeof gitDir !== "string") return null;
  const parts = [];
  for (const target of FINGERPRINT_TARGETS) {
    const filePath = target ? pathApi.join(gitDir, target) : gitDir;
    try {
      parts.push(String(fsApi.statSync(filePath).mtimeMs));
    } catch {
      // A missing packed-refs or index is normal in a fresh clone. Its absence is itself part of the
      // fingerprint, so creating one later counts as a change.
      parts.push("-");
    }
  }
  // The directory itself must have been readable; if every probe failed there is nothing to trust.
  return parts.every((part) => part === "-") ? null : parts.join(":");
}
