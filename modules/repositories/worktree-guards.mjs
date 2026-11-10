import fs from "node:fs";
import path from "node:path";
import { runGitProcess } from "./git-exec.mjs";

import { discoverWorktreeArtifacts } from "./worktree-artifacts.mjs";
import { RESERVED_PLANS_BRANCH } from "./worktree-inventory.mjs";

export async function checkWorktreeRemoval({ worktree, kind, landed = false, worktreeRoot = null, mainPath, currentPath, activePlan = false, running = false, consent = false, preservationEvidence = false, runGit = runGitProcess, fsApi = fs }) {
  if (worktree.reserved || worktree.branch === RESERVED_PLANS_BRANCH) return blocked("reserved plans worktree");
  if (worktree.prunable) return blocked("prunable worktree");
  if (kind === "automatic" && !landed) return blocked("not landed");
  if (kind === "automatic" && (!worktreeRoot || !inside(worktree.path, worktreeRoot))) return blocked("not in worktree folder");
  if (kind === "automatic" && (!worktree.branch || worktree.detached)) return blocked("detached worktree; suggested for removal");
  if (worktree.locked) return blocked("worktree locked");
  if (exists(path.join(worktree.path, ".gitmodules"), fsApi)) return blocked("worktree has submodules");
  if (samePath(worktree.path, mainPath) || (currentPath && (samePath(worktree.path, currentPath) || inside(currentPath, worktree.path)))) return blocked("current or main checkout");
  if (kind === "automatic" && activePlan) return blocked("plan not closed");
  if (running) return blocked("dev server running");
  const success = { ok: true, reason: null, warning: kind === "confirmed" && activePlan ? "plan still active" : null };
  if (preservationEvidence || (kind === "confirmed" && consent)) return success;
  const status = await runGit(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all", "-z"], { timeoutMs: 10000 });
  if (!status.ok) return blocked("working tree status unavailable");
  if (status.stdout.length) return blocked("uncommitted or untracked changes");
  let artifacts;
  try { artifacts = await discoverWorktreeArtifacts(worktree.path, { git: (args, options) => runGit(worktree.path, args, options), fsApi }); }
  catch { return blocked("ignored files status unavailable"); }
  if (artifacts.protected.length) return blocked(`valuable ignored path: ${artifacts.protected[0]}`);
  return success;
}

function blocked(reason) { return { ok: false, reason, warning: null }; }

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function samePath(left, right) {
  return Boolean(left && right && path.resolve(left) === path.resolve(right));
}

function exists(file, fsApi) {
  try { fsApi.statSync(file); return true; } catch { return false; }
}
