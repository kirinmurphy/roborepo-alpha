// Pure Claude MCP CLI-arg construction and invocation, extracted from scripts/cli/mcp-claude.mjs
// so the Claude provider adapter (scripts/harnesses/claude/index.mjs) can call it without
// importing scripts/cli/mcp-claude.mjs directly — that module's ensureClaudeMcpPermission needs
// paths.mjs's rootConfigActive/rootConfigBaseline (registry-dependent), and importing the whole
// file pulls that in at module-load time regardless of which export is actually used, cycling back
// through registry.mjs into the importing provider. addServer/removeServer/list never need the
// permission-grant path, so this leaf module has zero registry-touching imports.

import { spawnSync } from "node:child_process";
import fs from "node:fs";
import { selectedHarnessExecutable } from "../discovery.mjs";

const claudeManifest = JSON.parse(fs.readFileSync(new URL("../../../globals/harnesses/claude/provider.json", import.meta.url), "utf8"));

export function selectedClaudeExecutable() {
  return selectedHarnessExecutable(claudeManifest);
}

export function claudeMcpArgs(opts, spec) {
  const args = ["mcp", "add", "--scope", opts.scope];
  if (opts.transport) args.push("--transport", opts.transport);
  args.push(spec.name);
  if (!opts.transport || opts.transport === "stdio") args.push("--");
  args.push(spec.commandOrUrl, ...spec.args);
  return args;
}

// Returns { ok, status, message } instead of exiting: package enable runs inside the portal server,
// where one failing install must report `blocked`, not end the process. `roborepo mcp add` maps a
// failure back to its exit status.
export function runClaudeMcpAdd(args) {
  const executable = selectedClaudeExecutable();
  if (!executable) throw new Error("Claude Code has no validated CLI or desktop runtime");
  const result = spawnSync(executable, args, { stdio: "inherit" });
  if (result.error) return { ok: false, status: 1, message: `failed to run claude: ${result.error.message}` };
  const status = result.status ?? 1;
  return status === 0 ? { ok: true, status, message: "" } : { ok: false, status, message: `claude mcp add exited with status ${status}` };
}

export function hasClaudeCli() {
  return selectedClaudeExecutable() !== null;
}

export function claudeMcpRemove(name, scope) {
  const executable = selectedClaudeExecutable();
  return executable ? spawnSync(executable, ["mcp", "remove", name, "--scope", scope], { stdio: "ignore" }) : { status: 1 };
}

export function claudeMcpList() {
  const executable = selectedClaudeExecutable();
  if (!executable) return null;
  const result = spawnSync(executable, ["mcp", "list"], { encoding: "utf8" });
  if (result.error || result.status !== 0) return null;
  return result.stdout;
}
