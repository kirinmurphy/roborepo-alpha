import fs from "node:fs";
import path from "node:path";
import { runGitProcess } from "./git-exec.mjs";

const DISPOSABLE_IGNORED = ["node_modules/", "test-results/"];

export async function checkWorktreeRemoval({ worktree, kind, landed = false, worktreeRoot = null, mainPath, currentPath, activePlan = false, running = false, runGit = runGitProcess, fsApi = fs }) {
  if (worktree.prunable) return blocked("prunable worktree");
  if (kind === "automatic" && !landed) return blocked("not landed");
  if (kind === "automatic" && (!worktreeRoot || !inside(worktree.path, worktreeRoot))) return blocked("outside worktree root; suggested for removal");
  if (kind === "automatic" && (!worktree.branch || worktree.detached)) return blocked("detached worktree; suggested for removal");
  if (worktree.locked) return blocked("worktree locked");
  if (exists(path.join(worktree.path, ".gitmodules"), fsApi)) return blocked("worktree has submodules");
  if (samePath(worktree.path, mainPath) || samePath(worktree.path, currentPath)) return blocked("current or main checkout");
  if (kind === "automatic" && activePlan) return blocked("plan not closed");
  if (running) return blocked("dev server running");
  const status = await runGit(worktree.path, ["status", "--porcelain=v1", "--untracked-files=all"], { timeoutMs: 10000 });
  if (!status.ok) return blocked("working tree status unavailable");
  if (status.stdout.trim()) return blocked("uncommitted or untracked changes");
  // Normal untracked mode reports a wholly ignored directory once (`!! node_modules/`); listing all
  // files would enumerate every installed dependency and overflow the Git output buffer.
  const ignored = await runGit(worktree.path, ["status", "--ignored", "--porcelain=v1"], { timeoutMs: 10000 });
  if (!ignored.ok) return blocked("ignored files status unavailable");
  const valuable = ignored.stdout.split("\n")
    .filter((line) => line.startsWith("!! "))
    .map((line) => line.slice(3).trim())
    .find((file) => !DISPOSABLE_IGNORED.some((prefix) => file === prefix.slice(0, -1) || file.startsWith(prefix)));
  if (valuable) return blocked(`valuable ignored path: ${valuable}`);
  return { ok: true, reason: null, warning: kind === "confirmed" && activePlan ? "plan still active" : null };
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
