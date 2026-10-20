import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
import { STATE_ROOT } from "./paths.mjs";

const MARKER = "# roborepo-worktree-cleanup";
const DEFAULT_CLI = fileURLToPath(new URL("main.mjs", import.meta.url));

// Whether this repository's post-merge hook runs cleanup: "installed", "absent", "foreign" (another
// tool's hook is there), or "refused" (Git reads hooks from a shared global directory).
export async function inspectWorktreeHook({ cwd }) {
  const { target } = await resolveHook(cwd);
  if (target.refused) return { state: "refused", hook: null, reason: target.refused };
  const hook = path.join(target.dir, "post-merge");
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  const state = existing == null ? "absent" : existing.includes(MARKER) ? "installed" : "foreign";
  return { state, hook, reason: null };
}

export async function manageWorktreeHook({ cwd = process.cwd(), install = true, stateRoot = STATE_ROOT, cli = DEFAULT_CLI } = {}) {
  const { commonDir, target } = await resolveHook(cwd);
  if (target.refused) return { action: "refused", hook: null, reason: target.refused };
  const hook = path.join(target.dir, "post-merge");
  const scope = { scope: target.scope, checkout: target.checkout };
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  if (!install) {
    if (!existing?.includes(MARKER)) return { action: "unchanged", hook, ...scope };
    fs.rmSync(hook);
    return { action: "uninstalled", hook, ...scope };
  }
  // The hook runs the CLI from the path recorded here. A CLI inside one of this repository's linked
  // worktrees would be deleted by the cleanup it starts once that worktree lands.
  const host = linkedWorktrees(commonDir).find((worktree) => inside(realpath(cli), worktree.path));
  if (host) return { action: "refused", hook, reason: `the roborepo CLI at ${cli} is inside linked worktree ${host.path}, which cleanup can remove; install from the main checkout or an installed roborepo` };
  if (existing && !existing.includes(MARKER)) return { action: "foreign hook", hook, line: hookInvocation(stateRoot, cli), ...scope };
  const content = `#!/bin/sh\n${MARKER}\n${hookInvocation(stateRoot, cli)}\n`;
  if (existing === content) return { action: "unchanged", hook, ...scope };
  fs.mkdirSync(target.dir, { recursive: true });
  fs.writeFileSync(hook, content, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  return { action: "installed", hook, ...scope };
}

async function resolveHook(cwd) {
  const common = await runGitProcess(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error("Git common directory unavailable");
  const commonDir = common.stdout.trim();
  // The main checkout is the common directory's parent only when that directory is its `.git`. With
  // `--separate-git-dir` it lives elsewhere, and Git itself does not record the checkout's path
  // (`git worktree list` names the separate directory), so the main checkout stays unknown.
  const mainPath = path.basename(commonDir) === ".git" ? path.dirname(commonDir) : null;
  return { commonDir, target: await hooksTarget(cwd, commonDir, mainPath) };
}

// Git runs hooks from `core.hooksPath` when set, else `<common dir>/hooks`. A relative hooksPath is
// resolved against the working tree each hook runs in, so every linked worktree looks inside its own
// checkout: the hook written here fires only for merges in the checkout it is resolved against.
async function hooksTarget(cwd, commonDir, mainPath) {
  const result = await runGitProcess(cwd, ["config", "--show-scope", "--get-all", "core.hooksPath"]);
  // The seam's own `-c core.hooksPath=/dev/null` appears with the `command` scope; it is not the
  // repository's setting.
  const entries = result.ok
    ? result.stdout.split("\n").map((line) => line.split("\t")).filter(([scope, value]) => scope && scope !== "command" && value)
    : [];
  const effective = entries.at(-1);
  if (!effective) return { dir: path.join(commonDir, "hooks"), scope: "repository", checkout: null };
  const [scope, raw] = effective;
  if (scope !== "local" && scope !== "worktree") {
    return { refused: `core.hooksPath is set in ${scope} Git config (${raw}); a hook there would run cleanup for every repository that uses it` };
  }
  const value = raw === "~" ? os.homedir() : raw.startsWith("~/") ? path.join(os.homedir(), raw.slice(2)) : raw;
  // Worktree-scoped config (`extensions.worktreeConfig`) applies only to the checkout that set it.
  if (scope === "worktree") {
    const checkout = await toplevel(cwd);
    return { dir: path.resolve(checkout, value), scope: "checkout", checkout };
  }
  if (path.isAbsolute(value)) return { dir: value, scope: "repository", checkout: null };
  if (!mainPath) return { refused: `core.hooksPath (${raw}) is relative to the main checkout, which cannot be found because the repository's Git directory is outside it` };
  return { dir: path.resolve(mainPath, value), scope: "checkout", checkout: mainPath };
}

async function toplevel(cwd) {
  const result = await runGitProcess(cwd, ["rev-parse", "--show-toplevel"]);
  if (!result.ok) throw new Error("working tree unavailable");
  return result.stdout.trim();
}

function hookInvocation(stateRoot, cli) {
  const log = path.join(stateRoot, "worktree-cleanup", "hook.log");
  return `mkdir -p ${quote(path.dirname(log))}\ncurrent=$(git rev-parse --show-toplevel)\nnohup env ROBOREPO_STATE_DIR=${quote(stateRoot)} ${quote(process.execPath)} ${quote(cli)} git worktrees cleanup --apply --current "$current" >> ${quote(log)} 2>&1 </dev/null &`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function realpath(value) {
  try { return fs.realpathSync(value); } catch { return path.resolve(value); }
}

function inside(candidate, root) {
  const relative = path.relative(root, candidate);
  return Boolean(relative) && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

export async function worktreeHookCommand(args) {
  const [action] = args;
  if (!["install", "uninstall"].includes(action)) throw new Error("usage: roborepo git worktrees hook install|uninstall");
  const result = await manageWorktreeHook({ install: action === "install" });
  if (result.action === "refused") throw new Error(`hook not ${action}ed: ${result.reason}`);
  console.log(`${result.action}: ${result.hook}`);
  if (result.scope === "checkout") {
    console.log(`This hook fires only for merges and pulls in ${result.checkout}: core.hooksPath is relative or set for that worktree alone, so other checkouts resolve their own hooks directory.`);
  }
  if (result.line) console.log(`Add this line to the existing hook:\n${result.line}`);
  return result;
}
