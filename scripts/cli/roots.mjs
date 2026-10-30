// Machine/workspace/app root resolution — split out of paths.mjs so this stays a leaf module with
// no harness-registry dependency. state-paths.mjs (and anything downstream of it, including
// provider adapter code in scripts/harnesses/) needs STATE_ROOT without pulling in paths.mjs's
// harness-path section, which imports scripts/harnesses/registry.mjs and would otherwise create a
// cycle back into a provider's own index.mjs. paths.mjs re-exports everything here unchanged, so
// existing consumers see no difference.
//
// appRoot is the immutable application root: release files, built-ins, manifests, scripts, and CLI.
// workspaceRoot is the editable portable user workspace, defaulting under ~/.roborepo/workspace in
// both development and package mode so one machine has one workspace regardless of which entry
// point runs. STATE_ROOT is machine-local state.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

function envPath(name) {
  const value = process.env[name];
  return value ? path.resolve(value) : null;
}

function defaultAppRoot() {
  return path.resolve(here, "..", "..");
}

// Mode heuristic: a Git checkout (.git) or a dev-only local/skills dir means development mode;
// anything else (e.g. an extracted release tarball) is package mode. Because a `git clone` run from
// a copy stripped of .git would silently flip to package mode, ROBOREPO_MODE=development|package
// forces the mode explicitly for those edge cases.
function isDevelopmentCheckout(root) {
  const forced = process.env.ROBOREPO_MODE;
  if (forced === "development") return true;
  if (forced === "package") return false;
  return fs.existsSync(path.join(root, ".git")) || fs.existsSync(path.join(root, "local", "skills"));
}

export const appRoot = envPath("ROBOREPO_APP_ROOT") || defaultAppRoot();
export const STATE_ROOT =
  envPath("ROBOREPO_STATE_ROOT") ||
  path.join(os.homedir(), ".roborepo");
export const developmentMode = isDevelopmentCheckout(appRoot);
export const packageMode = !developmentMode;
function selectedWorkspaceRoot() {
  try {
    const data = JSON.parse(fs.readFileSync(path.join(STATE_ROOT, "workspace-root.json"), "utf8"));
    return data.workspaceRoot ? path.resolve(data.workspaceRoot) : null;
  } catch {
    return null;
  }
}
export const workspaceRoot =
  envPath("ROBOREPO_WORKSPACE_ROOT") ||
  selectedWorkspaceRoot() ||
  path.join(STATE_ROOT, "workspace");

// Backward-compatible names for modules that still operate on release/built-in files.
export const repoRoot = appRoot;
export const sharedSkillsDir = path.join(appRoot, "globals", "system", "skills");
export const workspaceSkillsDir = path.join(workspaceRoot, "skills");
export const workspaceCommandsDir = path.join(workspaceRoot, "commands");
export const workspaceMcpServersPath = path.join(workspaceRoot, "mcp", "servers.json");
export const workspacePackagesDir = path.join(workspaceRoot, "packages");
export const workspaceOverridesDir = path.join(workspaceRoot, "overrides");

export function requireDevelopmentCheckout(action) {
  if (!packageMode) return;
  const suffix = action ? ` for ${action}` : "";
  console.error(`requires development checkout${suffix}: this install is running in package mode.`);
  console.error(`appRoot: ${appRoot}`);
  console.error("Use a Git checkout for built-in source changes, or write custom content to the workspace.");
  process.exit(1);
}

export function workspaceManifestPath(root = workspaceRoot) {
  return path.join(root, "workspace.json");
}

export function initializeWorkspace({ root = workspaceRoot, dryRun = false } = {}) {
  const dirs = [
    root,
    path.join(root, "skills"),
    path.join(root, "commands"),
    path.join(root, "mcp"),
    path.join(root, "packages"),
    path.join(root, "overrides"),
  ];
  const manifestPath = workspaceManifestPath(root);
  const manifest = {
    schemaVersion: 1,
    kind: "managed-workspace",
    directories: {
      skills: "skills",
      commands: "commands",
      mcp: "mcp",
      packages: "packages",
      overrides: "overrides",
    },
  };

  if (dryRun) {
    for (const dir of dirs) console.log(`would create: ${dir}`);
    if (!fs.existsSync(manifestPath)) console.log(`would create: ${manifestPath}`);
    return { root, manifestPath, created: false };
  }

  for (const dir of dirs) fs.mkdirSync(dir, { recursive: true });
  if (!fs.existsSync(manifestPath)) {
    fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
  }
  const mcpServersPath = path.join(root, "mcp", "servers.json");
  if (!fs.existsSync(mcpServersPath)) {
    fs.writeFileSync(mcpServersPath, `${JSON.stringify({ servers: [] }, null, 2)}\n`);
  }
  return { root, manifestPath, created: true };
}

// True when `moduleUrl` is the module node was invoked with, i.e. the script is running as a CLI
// rather than being imported. Compares real paths on both sides deliberately: on macOS a script run
// from a temp dir arrives as `/var/...` in process.argv[1] while import.meta.url resolves through
// the /var -> /private/var symlink, so a direct string comparison is false and the entry-point block
// silently never runs — the CLI exits 0 having done nothing. Any symlinked checkout has the same
// shape. Falls back to the unresolved value when realpath fails (path missing), which keeps this
// usable as a plain guard rather than throwing at module load.
export function isMainModule(moduleUrl) {
  const invoked = process.argv[1];
  if (!invoked) return false;
  return realPathOrSelf(invoked) === realPathOrSelf(fileURLToPath(moduleUrl));
}

function realPathOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return target;
  }
}
