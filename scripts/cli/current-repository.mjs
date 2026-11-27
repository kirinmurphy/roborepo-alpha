// The canonical id of the repo `cwd` is in, from its `origin` remote; null outside a Git repo or
// without an origin.
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { normalizeGitRemote } from "../../modules/repositories/identity.mjs";

export async function currentRepositoryId(cwd) {
  const top = await runGitProcess(cwd, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) return null;
  const origin = await runGitProcess(top.stdout.trim(), ["remote", "get-url", "origin"]);
  return origin.ok ? normalizeGitRemote(origin.stdout.trim()) : null;
}
