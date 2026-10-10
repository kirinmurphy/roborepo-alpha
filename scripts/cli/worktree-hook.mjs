import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { runGitProcess } from "../../modules/repositories/git-exec.mjs";
import { STATE_ROOT } from "./paths.mjs";

const MARKER = "# roborepo-worktree-cleanup";

export async function manageWorktreeHook({ cwd = process.cwd(), install = true, stateRoot = STATE_ROOT } = {}) {
  const common = await runGitProcess(cwd, ["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (!common.ok) throw new Error("Git common directory unavailable");
  const mainPath = path.dirname(common.stdout.trim());
  const configured = await runGitProcess(cwd, ["config", "--local", "--get", "core.hooksPath"]);
  const hookDir = configured.ok && configured.stdout.trim()
    ? path.resolve(mainPath, configured.stdout.trim())
    : path.join(common.stdout.trim(), "hooks");
  const hook = path.join(hookDir, "post-merge");
  const existing = fs.existsSync(hook) ? fs.readFileSync(hook, "utf8") : null;
  if (!install) {
    if (!existing?.includes(MARKER)) return { action: "unchanged", hook };
    fs.rmSync(hook);
    return { action: "uninstalled", hook };
  }
  if (existing && !existing.includes(MARKER)) return { action: "foreign hook", hook, line: hookInvocation(stateRoot) };
  const content = `#!/bin/sh\n${MARKER}\n${hookInvocation(stateRoot)}\n`;
  if (existing === content) return { action: "unchanged", hook };
  fs.mkdirSync(hookDir, { recursive: true });
  fs.writeFileSync(hook, content, { mode: 0o755 });
  fs.chmodSync(hook, 0o755);
  return { action: "installed", hook };
}

function hookInvocation(stateRoot) {
  const cli = fileURLToPath(new URL("main.mjs", import.meta.url));
  const log = path.join(stateRoot, "worktree-cleanup", "hook.log");
  return `mkdir -p ${quote(path.dirname(log))}\ncurrent=$(git rev-parse --show-toplevel)\nnohup env ROBOREPO_STATE_DIR=${quote(stateRoot)} ${quote(process.execPath)} ${quote(cli)} git worktrees cleanup --apply --current "$current" >> ${quote(log)} 2>&1 </dev/null &`;
}

function quote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

export async function worktreeHookCommand(args) {
  const [action] = args;
  if (!["install", "uninstall"].includes(action)) throw new Error("usage: roborepo git worktrees hook install|uninstall");
  const result = await manageWorktreeHook({ install: action === "install" });
  console.log(`${result.action}: ${result.hook}`);
  if (result.line) console.log(`Add this line to the existing hook:\n${result.line}`);
  return result;
}
