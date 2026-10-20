// Claude's MCP capability adapter methods. Split out of index.mjs (which grew past this repo's
// 150-200 line file-size guidance once rootConfig/hooks-withdraw/telemetry/transcripts were all
// added alongside these four MCP methods) — a single-purpose module for one capability group.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../../cli/roots.mjs";
import { claudeMcpArgs, runClaudeMcpAdd, hasClaudeCli, claudeMcpRemove, claudeMcpList } from "../mcp-claude-cli.mjs";

// Mirrors scripts/cli/mcp-config.mjs's MCP_SERVERS_PATH/MCP_SCOPES, duplicated rather than
// imported: mcp-config.mjs pulls in paths.mjs's registry-dependent half (rootConfigActive/
// rootConfigBaseline), which would cycle back through registry.mjs into this module — the same
// paths.mjs/roots.mjs import-cycle issue. roots.mjs is the
// registry-independent leaf, safe to import directly.
const MCP_SERVERS_PATH = path.join(repoRoot, "manifests", "inventory", "mcp-servers.json");
const MCP_SCOPES = ["user", "local", "project"];

// Ported from scripts/install/uninstall.sh's remove_mcp_servers (characterization test:
// scripts/test/harness-mcp-remove-characterization-check.mjs), which this replaces — the shell
// function now calls this adapter instead of its own inline bash+node. `claude mcp add` registers
// at a chosen scope (default "user"); `claude mcp remove` without --scope only checks the default
// ("local"), so a single remove leaks the other scopes. Removes from every scope via the CLI when
// available, then prunes ~/.claude.json directly as a fallback so the entry is gone even when the
// `claude` binary isn't present.
export function mcpRemove({ homePath, dryRun = false } = {}) {
  const paths = [];
  const warnings = [];
  let names = [];
  try {
    const manifest = JSON.parse(fs.readFileSync(MCP_SERVERS_PATH, "utf8"));
    names = (manifest.servers || [])
      .filter((server) => (server.harnesses || []).includes("claude"))
      .map((server) => server.name);
  } catch (err) {
    warnings.push(`could not read ${MCP_SERVERS_PATH}: ${err.message}`);
  }

  if (names.length === 0) {
    return { ok: true, changed: false, providerId: "claude", action: "mcp.remove", paths, warnings };
  }

  if (dryRun) {
    return { ok: true, changed: false, providerId: "claude", action: "mcp.remove", paths, warnings: [...warnings, `dry-run: would remove ${names.join(", ")} from all scopes`] };
  }

  if (hasClaudeCli()) {
    for (const name of names) {
      for (const scope of MCP_SCOPES) claudeMcpRemove(name, scope);
    }
    warnings.push(`ran 'claude mcp remove' for ${names.join(", ")} across all scopes (best-effort; the CLI does not report whether anything was actually registered)`);
  }

  const claudeJsonPath = path.join(homePath, "..", ".claude.json");
  let changed = false;
  try {
    const raw = fs.readFileSync(claudeJsonPath, "utf8");
    const data = JSON.parse(raw);
    const nameSet = new Set(names);
    const prune = (servers) => {
      if (!servers) return;
      for (const name of nameSet) {
        if (name in servers) {
          delete servers[name];
          changed = true;
        }
      }
    };
    prune(data.mcpServers);
    for (const project of Object.values(data.projects || {})) prune(project.mcpServers);
    if (changed) {
      fs.writeFileSync(claudeJsonPath, `${JSON.stringify(data, null, 2)}\n`);
      paths.push(claudeJsonPath);
    }
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`could not prune ${claudeJsonPath}: ${err.message}`);
  }

  return {
    ok: true,
    changed,
    providerId: "claude",
    action: "mcp.remove",
    paths,
    warnings,
  };
}

// Single-server add: shells to `claude mcp add` (the only way to register with Claude's own MCP
// client state — there is no direct config file to write into, unlike Codex's TOML table). Thin
// wrapper over the pure arg-construction/invocation in ../mcp-claude-cli.mjs; unchanged behavior
// from scripts/cli/mcp.mjs's existing mcpAdd, ownership moved behind the contract.
export function mcpAddServer(spec, opts = {}) {
  const args = claudeMcpArgs({ scope: opts.scope || "user", transport: opts.transport || null }, spec);
  if (opts.dryRun) return { ok: true, changed: false, providerId: "claude", action: "mcp.addServer", paths: [], warnings: [`dry-run: claude ${args.join(" ")}`] };
  runClaudeMcpAdd(args);
  return { ok: true, changed: true, providerId: "claude", action: "mcp.addServer", paths: [], warnings: [] };
}

// Single-server remove: same "remove --scope without an explicit scope only checks one scope"
// gap mcpRemove (bulk) already accounts for -- sweeps every scope via the CLI when available, then
// prunes ~/.claude.json directly so the entry is gone even when the `claude` binary isn't present.
export function mcpRemoveServer(name, { homePath, dryRun = false } = {}) {
  if (dryRun) return { ok: true, changed: false, providerId: "claude", action: "mcp.removeServer", warnings: [`dry-run: would remove ${name} from all scopes`] };

  const warnings = [];
  if (hasClaudeCli()) {
    for (const scope of MCP_SCOPES) claudeMcpRemove(name, scope);
    warnings.push(`ran 'claude mcp remove' for ${name} across all scopes (best-effort; the CLI does not report whether anything was actually registered)`);
  }

  const claudeJsonPath = path.join(homePath, "..", ".claude.json");
  let changed = false;
  const paths = [];
  try {
    const data = JSON.parse(fs.readFileSync(claudeJsonPath, "utf8"));
    const prune = (servers) => {
      if (servers && name in servers) { delete servers[name]; changed = true; }
    };
    prune(data.mcpServers);
    for (const project of Object.values(data.projects || {})) prune(project.mcpServers);
    if (changed) {
      fs.writeFileSync(claudeJsonPath, `${JSON.stringify(data, null, 2)}\n`);
      paths.push(claudeJsonPath);
    }
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`could not prune ${claudeJsonPath}: ${err.message}`);
  }

  return { ok: true, changed, providerId: "claude", action: "mcp.removeServer", paths, warnings };
}

// Server names Claude currently has registered, via `claude mcp list`. Returns [] (not an error)
// when the CLI is unavailable or the call fails — listing is a best-effort read, not a capability
// gate.
export function mcpList() {
  const output = claudeMcpList();
  if (!output) return [];
  return [...output.matchAll(/^([^\s:]+):/gm)].map((match) => match[1]);
}
