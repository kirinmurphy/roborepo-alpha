import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { setWorktreeCleanup, updateRegistry } from "../../modules/repositories/registry.mjs";
import { manageWorktreeHook } from "./worktree-hook.mjs";
import { repositoryMainCheckout } from "./worktree-cleanup.mjs";
import { configuredRoot } from "./worktree-policy.mjs";
import { STATE_ROOT } from "./paths.mjs";

// Home's "Turn on automatic cleanup": record the folder automatic removal may act in, then install
// the post-merge hook. A plans config's `worktreeRoot` wins over the submitted folder, as it does in
// the guards. A refused install records nothing, so the offer stays up with its reason.
export async function enableWorktreeCleanup({ repositoryId, folder, stateRoot = STATE_ROOT }) {
  const main = repositoryMainCheckout(repositoryId, stateRoot);
  const root = configuredRoot(main) || confirmedFolder(folder, main);
  const result = await manageWorktreeHook({ cwd: main, stateRoot });
  if (result.action === "refused") return { action: "refused", reason: result.reason, hook: result.hook };
  updateRegistry({ stateRoot, mutate: (registry) => setWorktreeCleanup(registry, repositoryId, { root }) });
  return { action: result.action, hook: result.hook, line: result.line || null, scope: result.scope, checkout: result.checkout, root };
}

export function dismissWorktreeCleanupNotice({ repositoryId, stateRoot = STATE_ROOT, now = new Date() }) {
  updateRegistry({ stateRoot, mutate: (registry) => setWorktreeCleanup(registry, repositoryId, { noticeDismissedAt: now.toISOString() }) });
  return { action: "dismissed" };
}

// Automatic removal acts on every landed worktree beneath the folder, so it must exist and must not
// be the home directory, one of its parents, or the main checkout itself.
function confirmedFolder(folder, main) {
  if (typeof folder !== "string" || !path.isAbsolute(folder)) throw invalid("Enter the absolute path of the folder holding this repository's worktrees.");
  let resolved;
  try { resolved = fs.realpathSync(folder); } catch { throw invalid(`Folder not found: ${folder}`); }
  if (!fs.statSync(resolved).isDirectory()) throw invalid(`Not a folder: ${folder}`);
  const home = fs.realpathSync(os.homedir());
  if (resolved === path.parse(resolved).root || resolved === home || home.startsWith(`${resolved}${path.sep}`)) {
    throw invalid("Choose the folder that holds the worktrees, not your home directory or one of its parents.");
  }
  if (resolved === fs.realpathSync(main)) throw invalid("Choose the folder holding the worktrees, not the repository itself.");
  return resolved;
}

function invalid(message) {
  return Object.assign(new Error(message), { code: "INVALID_WORKTREE_FOLDER" });
}
