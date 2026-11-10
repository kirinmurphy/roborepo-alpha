import path from "node:path";
import { PLANS_BRANCH, locateStore } from "../../../modules/plan-suite/plan-store.mjs";

// Codex's workspace roots cover the plans worktree's files, but its Git state lives in the
// repository's common Git directory, usually outside them. Without a grant, `git add` in the store
// fails on the worktree's index.lock.
//
// These are the exact paths a store commit, fetch, and fast-forward write. The whole Git directory
// is not granted: writing `hooks/` or `config` would run code outside the sandbox, and writing
// `packed-refs` could move other branches. Git prints a packed-refs warning on these commands and
// exits 0 regardless. Codex accepts `write` only on an exact path or a trailing `/**`, so each ref's
// `.lock` is listed.
export function codexPlansStoreWritablePaths({ cwd = process.cwd() } = {}) {
  const store = locateStore(cwd);
  if (!store || store.missing) return [];
  const inCommonDir = (relative) => path.join(store.commonDir, relative);
  const refs = [`refs/heads/${PLANS_BRANCH}`, `refs/remotes/origin/${PLANS_BRANCH}`];
  return [
    inCommonDir("objects/**"),
    path.join(store.adminDir, "**"),
    ...refs.flatMap((ref) => [ref, `${ref}.lock`, `logs/${ref}`, `logs/${ref}.lock`]).map(inCommonDir),
  ];
}
