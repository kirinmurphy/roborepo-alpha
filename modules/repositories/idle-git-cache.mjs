// Cross-poll Git context cache for idle checkouts. Git-directory mtimes invalidate entries after
// some Git operations, reducing subprocess reads during portal polling. Working-tree edits can
// leave those mtimes unchanged, so cached dirty state can be stale. Refresh policy remains open.
import fs from "node:fs";
import path from "node:path";

// HEAD, index, and packed-refs track selected Git metadata changes. The directory mtime detects
// direct child creation/removal; it does not track edits to checkout files or nested loose refs.
const FINGERPRINT_TARGETS = ["", "HEAD", "index", "packed-refs"];

export function createIdleGitCache({ fsApi = fs, pathApi = path } = {}) {
  const entries = new Map();

  return {
    // Reuses context while the sampled Git metadata mtimes match, otherwise calls readFn and
    // stores the result against the current fingerprint.
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
