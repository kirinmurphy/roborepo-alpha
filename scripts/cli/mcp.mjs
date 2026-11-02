import fs from "node:fs";
import path from "node:path";
import { loadMcpPresets } from "./mcp-presets.mjs";
import { parseMcpAdd, resolveMcpHarnesses } from "./mcp-parse.mjs";
import { claudeMcpArgs, ensureClaudeMcpPermission, shellQuote } from "./mcp-claude.mjs";
import { MCP_SERVERS_PATH } from "./mcp-config.mjs";
import { initializeWorkspace, packageMode, workspaceMcpServersPath } from "./paths.mjs";
import { hasReplaceOverride, loadWorkspaceMcpServers, readWorkspaceOverrides } from "./workspace-resources.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { validateAdapterActionResult } from "../harnesses/schemas.mjs";
import { configFileMcpProviders, capitalize, ensureConfigFileMcp } from "./mcp-config-file.mjs";

// Re-exported for packages.mjs, which needs these generic helpers but must not trigger this
// module's eager loadMcpPresets() call below — import directly from mcp-config-file.mjs there
// instead of through this module, so a missing/broken mcp-presets.json in a minimal sandbox can
// never crash a package-mode command that has nothing to do with mcpAdd/mcpApply.
export { configFileMcpProviders, ensureConfigFileMcp } from "./mcp-config-file.mjs";

const mcpPresets = loadMcpPresets();

function readMcpServers() {
  let builtIn;
  try {
    builtIn = JSON.parse(fs.readFileSync(MCP_SERVERS_PATH, "utf8"));
  } catch {
    return { servers: [] };
  }
  if (!packageMode) return builtIn;
  return { servers: mergeWorkspaceServers(builtIn.servers || []) };
}

function mcpServersPath() {
  return packageMode ? workspaceMcpServersPath : MCP_SERVERS_PATH;
}

// The file we write records to, read raw. In package mode this is the workspace-only file — never
// the built-in+workspace merge that readMcpServers() returns, or built-ins would be copied into the
// workspace file and then trip the built-in conflict guard on the next validate/apply.
function readRecordServers() {
  try {
    return JSON.parse(fs.readFileSync(mcpServersPath(), "utf8"));
  } catch {
    return { servers: [] };
  }
}

function recordMcpServer(spec, harnesses) {
  if (packageMode) initializeWorkspace();
  if (packageMode) assertMcpRecordAllowed(spec.name);
  const data = readRecordServers();
  const existing = data.servers.find((s) => s.name === spec.name);

  if (existing) {
    existing.commandOrUrl = spec.commandOrUrl;
    existing.args = spec.args;
    existing.harnesses = harnesses;
    console.log(`mcp-servers.json updated: ${spec.name}`);
  } else {
    data.servers.push({ name: spec.name, commandOrUrl: spec.commandOrUrl, args: spec.args, harnesses });
    console.log(`mcp-servers.json recorded: ${spec.name}`);
  }
  fs.mkdirSync(path.dirname(mcpServersPath()), { recursive: true });
  fs.writeFileSync(mcpServersPath(), `${JSON.stringify(data, null, 2)}\n`);
}

function mergeWorkspaceServers(builtInServers) {
  const overrides = readWorkspaceOverrides();
  const byName = new Map(builtInServers.map((server) => [server.name, server]));
  for (const server of loadWorkspaceMcpServers({ builtInNames: new Set(byName.keys()), overrides })) {
    if (byName.has(server.name) && !hasReplaceOverride("mcp-server", server.name, overrides)) {
      throw new Error(`workspace MCP server '${server.name}' conflicts with built-in server without typed replace override`);
    }
    byName.set(server.name, server);
  }
  return [...byName.values()];
}

function assertMcpRecordAllowed(name) {
  let builtIn = [];
  try {
    builtIn = JSON.parse(fs.readFileSync(MCP_SERVERS_PATH, "utf8")).servers || [];
  } catch {
    return;
  }
  if (!builtIn.some((server) => server.name === name)) return;
  if (hasReplaceOverride("mcp-server", name)) return;
  throw new Error(`MCP server '${name}' is built in; add a typed mcp-server replace override before replacing it`);
}

function claudeHasMcp(serverName) {
  const names = getHarnessProvider("claude").adapters.mcp.list();
  return names.includes(serverName);
}

// The terminal `mcp` commands stop at the first failing Claude install with the CLI's own exit
// status, as they always have; package enable checks the adapter's ok:false instead.
function addClaudeServerOrExit(spec, opts) {
  const result = getHarnessProvider("claude").adapters.mcp.addServer(spec, opts);
  validateAdapterActionResult(result);
  if (result.ok) return;
  for (const warning of result.warnings) console.error(warning);
  process.exit(result.exitStatus ?? 1);
}

export function mcpApply({ dryRun = false } = {}) {
  const data = readMcpServers();
  const configFileProviders = configFileMcpProviders();
  for (const server of data.servers) {
    const spec = { name: server.name, commandOrUrl: server.commandOrUrl, args: server.args };
    const applyClaude = server.harnesses.includes("claude");
    if (dryRun) {
      if (applyClaude) console.log(`would apply Claude MCP live store: ${server.name}`);
      for (const provider of configFileProviders) {
        if (server.harnesses.includes(provider.id)) {
          console.log(`would apply ${capitalize(provider.id)} MCP active config: ${server.name}`);
        }
      }
      continue;
    }
    if (applyClaude) {
      if (claudeHasMcp(spec.name)) {
        console.log(`claude MCP already present: ${server.name}`);
      } else {
        addClaudeServerOrExit(spec, { scope: "user", transport: null });
      }
    }
    for (const provider of configFileProviders) {
      if (server.harnesses.includes(provider.id)) ensureConfigFileMcp(provider, spec);
    }
  }
}

export function mcpAdd(rest) {
  const { opts, spec } = parseMcpAdd(rest, mcpPresets);
  const harnesses = resolveMcpHarnesses(opts);
  const applyClaude = harnesses.includes("claude");
  const targetProviders = configFileMcpProviders().filter((provider) => harnesses.includes(provider.id));
  const args = claudeMcpArgs(opts, spec);
  const display = ["claude", ...args].map(shellQuote).join(" ");

  if (opts.dryRun) {
    if (applyClaude) console.log(display);
    if (applyClaude && opts.updateClaudePermission) {
      console.log(`would add permission: mcp__${spec.name} -> generated/claude/settings.json`);
    }
    for (const provider of targetProviders) ensureConfigFileMcp(provider, spec, { dryRun: true });
    return;
  }

  if (applyClaude) {
    addClaudeServerOrExit(spec, { scope: opts.scope, transport: opts.transport });
    if (opts.updateClaudePermission) ensureClaudeMcpPermission(spec.name);
  }
  for (const provider of targetProviders) ensureConfigFileMcp(provider, spec);
  // Built-in package presets already live in the app's mcp-servers.json; recording them again would
  // duplicate a built-in into the user workspace and trip assertMcpRecordAllowed. Only user-added
  // servers get a workspace record.
  if (!opts.builtIn) recordMcpServer(spec, harnesses);
  process.exit(0);
}
