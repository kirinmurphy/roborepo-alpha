import fs from "node:fs";
import path from "node:path";
import {
  appRoot,
  initializeWorkspace,
  packageMode,
  stateRoot,
  workspaceManifestPath,
  workspaceRoot,
} from "./paths.mjs";
import { writeJsonState } from "./state-paths.mjs";
import { validateWorkspace } from "./workspace-resources.mjs";

const WORKSPACE_POINTER = "workspace-root.json";

function workspacePointerPath() {
  return path.join(stateRoot, WORKSPACE_POINTER);
}

export function readPackageVersion() {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
    return pkg.version || "0.0.0";
  } catch {
    return "0.0.0";
  }
}

export function versionCommand() {
  console.log(`roborepo ${readPackageVersion()}`);
  console.log(`mode: ${packageMode ? "package" : "development"}`);
  console.log(`appRoot: ${appRoot}`);
  console.log(`workspaceRoot: ${workspaceRoot}`);
  console.log(`stateRoot: ${stateRoot}`);
}

export function workspaceCommand(args) {
  const [sub, ...rest] = args;
  if (sub === "status" || sub === undefined) return workspaceStatus();
  if (sub === "use") return workspaceUse(rest);
  if (sub === "validate") return workspaceValidate(rest);
  console.error(`unknown: roborepo workspace ${sub}`);
  console.error("usage: roborepo workspace status | use <path> | validate");
  process.exit(2);
}

function workspaceStatus() {
  const manifest = workspaceManifestPath();
  console.log(`mode: ${packageMode ? "package" : "development"}`);
  console.log(`appRoot: ${appRoot}`);
  console.log(`workspaceRoot: ${workspaceRoot}`);
  console.log(`stateRoot: ${stateRoot}`);
  console.log(`workspace.json: ${fs.existsSync(manifest) ? manifest : "missing"}`);
}

function workspaceUse(args) {
  const target = args[0];
  const invalid = args.slice(1);
  if (!target || invalid.length > 0) {
    console.error("usage: roborepo workspace use <path>");
    process.exit(2);
  }
  const root = path.resolve(target);
  initializeWorkspace({ root });
  writeJsonState(workspacePointerPath(), { workspaceRoot: root });
  console.log(`workspace selected: ${root}`);
  console.log(`Recorded in ${workspacePointerPath()}; reused automatically while stateRoot stays ${stateRoot}.`);
  console.log("Override per-shell with ROBOREPO_WORKSPACE_ROOT (takes precedence over this pointer).");
}

function workspaceValidate(args) {
  if (args.length > 0) {
    console.error("usage: roborepo workspace validate");
    process.exit(2);
  }
  validateWorkspace();
  console.log(`workspace valid: ${workspaceRoot}`);
}

export function setupCommand(args) {
  const dryRun = args.includes("--dry-run");
  const invalid = args.filter((arg) => arg !== "--dry-run");
  if (invalid.length > 0) {
    console.error(`unknown flag for setup: ${invalid.join(" ")}`);
    process.exit(2);
  }
  initializeWorkspace({ dryRun });
  if (dryRun) {
    console.log(`would create state root: ${stateRoot}`);
    return;
  }
  fs.mkdirSync(stateRoot, { recursive: true });
  console.log(`workspace ready: ${workspaceRoot}`);
  console.log(`state ready: ${stateRoot}`);
}
