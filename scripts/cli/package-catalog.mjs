import fs from "node:fs";
import path from "node:path";
import { repoRoot, workspacePackagesDir } from "./paths.mjs";
import { experimentalStatePath } from "./state-paths.mjs";
import { readWorkspaceOverrides, hasReplaceOverride } from "./workspace-resources.mjs";
import { hasHarnessProvider, getHarnessProvider } from "../harnesses/registry.mjs";

export const PACKAGE_CATEGORIES_PATH = path.join(repoRoot, "manifests", "inventory", "package-categories.json");
export const BUILT_IN_PACKAGES_DIR = path.join(repoRoot, "globals", "packages");
export const ARCHIVED_PACKAGES_DIR = path.join(repoRoot, "globals", "packages-archived");
export const EXPERIMENTAL_PACKAGES_ENV = "LOAD_EXPERIMENTAL_PACKAGES";

const PENDING_STATUS = "pending";
const SUPPORTED_SCHEMA = 1;
const PACKAGE_LIFECYCLES = new Set(["optional", "system"]);
const RESOURCE_TYPES = new Set([
  "skill",
  "slash-command",
  "rules",
  "hooks",
  "permissions",
  "codex_tool_approvals",
  "mcp",
  "plugin",
  "service",
  "cli-command",
  "harness-config",
  "package-runtime-asset",
]);
const SKILL_INVOCATIONS = new Set(["auto", "manual"]);
const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

function readExperimentalState() {
  try {
    return JSON.parse(fs.readFileSync(experimentalStatePath, "utf8"));
  } catch {
    return {};
  }
}

function writeExperimentalState(enabled) {
  fs.mkdirSync(path.dirname(experimentalStatePath), { recursive: true });
  fs.writeFileSync(experimentalStatePath, JSON.stringify({ enabled, updatedAt: new Date().toISOString() }, null, 2) + "\n");
}

export function experimentalPackagesEnabled(env = process.env) {
  return env[EXPERIMENTAL_PACKAGES_ENV] === "true" || readExperimentalState().enabled === true;
}

export function experimentalCommand(args) {
  const [sub] = args;
  switch (sub) {
    case "enable":
      writeExperimentalState(true);
      console.log("experimental packages enabled");
      return;
    case "disable":
      writeExperimentalState(false);
      console.log("experimental packages disabled");
      return;
    case "status":
      console.log(experimentalPackagesEnabled() ? "enabled" : "disabled");
      return;
    default:
      console.error("usage: roborepo experimental enable|disable|status");
      process.exit(2);
  }
}

export function readPackageManifest() {
  return { packages: readBuiltInPackageConfigs() };
}

export function readPackageCategories() {
  const data = JSON.parse(fs.readFileSync(PACKAGE_CATEGORIES_PATH, "utf8"));
  if (data.schemaVersion !== SUPPORTED_SCHEMA || !Array.isArray(data.categories)) {
    throw new Error("package category registry must contain { schemaVersion: 1, categories: [...] }");
  }
  const seen = new Set();
  return data.categories.map((category) => {
    if (!isSlug(category.id)) throw new Error(`invalid package category id: ${category.id || "(missing)"}`);
    if (seen.has(category.id)) throw new Error(`duplicate package category id: ${category.id}`);
    seen.add(category.id);
    if (typeof category.label !== "string" || category.label.trim() === "") {
      throw new Error(`package category ${category.id} needs label`);
    }
    return {
      id: category.id,
      label: category.label,
      // Optional section prose, rendered by whichever consumer displays the category. Kept in the
      // manifest so adding a category never requires a template or printer edit.
      description: typeof category.description === "string" ? category.description : undefined,
      footnote: typeof category.footnote === "string" ? category.footnote : undefined,
      // Opt-in section-level bulk enable/disable (portal renders one group switch for the section).
      // Explicit === true: any other value (including absent) means the capability is off.
      bulkToggle: category.bulkToggle === true,
      order: Number.isFinite(category.order) ? category.order : 0,
    };
  });
}

function readBuiltInPackageConfigs() {
  return [BUILT_IN_PACKAGES_DIR, ARCHIVED_PACKAGES_DIR]
    .flatMap((root) => packageConfigFiles(root))
    .map((file) => readPackageConfig(file, "built-in"));
}

function readWorkspacePackageConfigs({ builtInIds = new Set(), overrides = readWorkspaceOverrides() } = {}) {
  const packages = packageConfigFiles(workspacePackagesDir).map((file) => readPackageConfig(file, "workspace"));
  const seen = new Set();
  for (const pkg of packages) {
    if (seen.has(pkg.id)) throw new Error(`duplicate workspace package id: ${pkg.id}`);
    if (builtInIds.has(pkg.id) && !hasReplaceOverride("package", pkg.id, overrides)) {
      throw new Error(`workspace package '${pkg.id}' conflicts with a built-in package; add a typed package replace override to overrides/resources.json`);
    }
    seen.add(pkg.id);
  }
  return packages;
}

function packageConfigFiles(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name, "package.config.json"))
    .filter((file) => fs.existsSync(file))
    .sort();
}

function readPackageConfig(file, origin) {
  const data = JSON.parse(fs.readFileSync(file, "utf8"));
  return normalizePackage(data, {
    file,
    root: path.dirname(file),
    origin,
  });
}

function mergeWorkspacePackages(packages) {
  const overrides = readWorkspaceOverrides();
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const workspacePackages = readWorkspacePackageConfigs({ builtInIds: new Set(byId.keys()), overrides });
  for (const pkg of workspacePackages) {
    if (byId.has(pkg.id) && !hasReplaceOverride("package", pkg.id, overrides)) {
      throw new Error(`workspace package '${pkg.id}' conflicts with built-in package without typed replace override`);
    }
    byId.set(pkg.id, pkg);
  }
  return [...byId.values()];
}

export function isPackageAvailable(pkg, env = process.env) {
  return pkg.status !== PENDING_STATUS || experimentalPackagesEnabled(env);
}

export function loadPackageCatalog({ includeUnavailable = false, env = process.env } = {}) {
  const packages = mergeWorkspacePackages(readPackageManifest().packages || []);
  validatePackageCatalog(packages);
  const available = includeUnavailable ? packages : packages.filter((pkg) => isPackageAvailable(pkg, env));
  return available.sort(packageSort);
}

export function findPackageInManifest(pkgId) {
  return loadPackageCatalog({ includeUnavailable: true }).find((pkg) => pkg.id === pkgId) || null;
}

export function unavailablePackageReason(pkg, env = process.env) {
  if (isPackageAvailable(pkg, env)) return null;
  if (pkg.status === PENDING_STATUS) {
    return "pending package: run `roborepo experimental enable` to expose it";
  }
  return `unavailable package status: ${pkg.status}`;
}

export function unavailablePackageMessage(pkgId, env = process.env) {
  const pkg = findPackageInManifest(pkgId);
  return pkg ? unavailablePackageReason(pkg, env) : `unknown package: ${pkgId}`;
}

export function validatePackageCatalog(packages) {
  const categories = new Set(readPackageCategories().map((category) => category.id));
  const errors = [];
  const packageIds = new Set();
  const skillIds = new Map();
  const slashNames = new Map();
  const cliCommands = new Map();

  for (const pkg of packages) {
    if (packageIds.has(pkg.id)) errors.push(`duplicate package id: ${pkg.id}`);
    packageIds.add(pkg.id);
    if (!categories.has(pkg.presentation.category)) {
      errors.push(`${pkg.id}: unknown presentation category: ${pkg.presentation.category}`);
    }
    for (const dep of pkg.requires || []) {
      if (!isSlug(dep)) errors.push(`${pkg.id}: invalid required package id: ${dep}`);
    }
    for (const resource of pkg.resources) {
      if (resource.type === "skill") {
        claim(skillIds, resource.id, pkg.id, errors, "skill");
        for (const entrypoint of resource.entrypoints || []) {
          if (entrypoint.type === "slash-command") claim(slashNames, entrypoint.name, pkg.id, errors, "slash command");
        }
      } else if (resource.type === "slash-command") {
        claim(slashNames, resource.name, pkg.id, errors, "slash command");
      } else if (resource.type === "cli-command" || resource.type === "command") {
        claim(cliCommands, resource.name, pkg.id, errors, "CLI command");
      }
    }
  }

  for (const pkg of packages) {
    for (const dep of pkg.requires || []) {
      if (!packageIds.has(dep)) errors.push(`${pkg.id}: missing required package: ${dep}`);
    }
  }
  errors.push(...dependencyCycleErrors(packages));
  if (errors.length > 0) throw new Error(errors.join("\n"));
  return { ok: true };
}

function normalizePackage(pkg, { file, root, origin }) {
  if (!pkg || typeof pkg !== "object") throw new Error(`invalid package config: ${file}`);
  if (pkg.schemaVersion !== SUPPORTED_SCHEMA) throw new Error(`${file}: schemaVersion must be ${SUPPORTED_SCHEMA}`);
  if (!isSlug(pkg.id)) throw new Error(`${file}: invalid package id`);
  const dirId = path.basename(root);
  if (dirId !== pkg.id) throw new Error(`${file}: package directory must match id (${pkg.id})`);
  if (typeof pkg.label !== "string" || pkg.label.trim() === "") throw new Error(`${pkg.id}: label is required`);
  if (typeof pkg.description !== "string" || pkg.description.trim() === "") throw new Error(`${pkg.id}: description is required`);
  const lifecycle = pkg.lifecycle || "optional";
  if (!PACKAGE_LIFECYCLES.has(lifecycle)) throw new Error(`${pkg.id}: unknown lifecycle: ${lifecycle}`);
  if (pkg.defaultEnabled !== undefined && typeof pkg.defaultEnabled !== "boolean") {
    throw new Error(`${pkg.id}: defaultEnabled must be a boolean`);
  }
  const presentation = normalizePresentation(pkg);
  const resources = normalizeResources(pkg.resources, { pkgId: pkg.id, file, root });
  // Self-declared behavior capabilities (e.g. "doc-lookup", "code-lookup") — how consumers match
  // this package to a telemetry hint WITHOUT hardcoding its id. Optional and unvalidated by
  // design: an unrecognized capability is inert, never an install error.
  const capabilities = Array.isArray(pkg.capabilities)
    ? pkg.capabilities.filter((c) => typeof c === "string" && c.trim()).map((c) => c.trim())
    : [];
  return {
    ...pkg,
    lifecycle,
    defaultEnabled: pkg.defaultEnabled === true,
    capabilities,
    presentation,
    requires: Array.isArray(pkg.requires) ? [...pkg.requires] : [],
    resources,
    components: resources.map((resource) => componentResource(resource, root)).filter(Boolean),
    sourceRoot: root,
    sourceFile: file,
    origin,
    archived: path.resolve(root).startsWith(`${path.resolve(ARCHIVED_PACKAGES_DIR)}${path.sep}`),
  };
}

function normalizePresentation(pkg) {
  const presentation = pkg.presentation || {};
  const category = presentation.category;
  if (!isSlug(category)) throw new Error(`${pkg.id}: presentation.category is required`);
  const order = presentation.order === undefined ? 0 : Number(presentation.order);
  if (!Number.isFinite(order)) throw new Error(`${pkg.id}: presentation.order must be numeric`);
  return { category, order };
}

function normalizeResources(resources, { pkgId, file, root }) {
  if (!Array.isArray(resources)) throw new Error(`${pkgId}: resources must be an array`);
  return resources.map((resource, index) => normalizeResource(resource, { pkgId, file, root, index }));
}

function normalizeResource(resource, { pkgId, root, index }) {
  if (!resource || typeof resource !== "object") throw new Error(`${pkgId}: resource ${index + 1} must be an object`);
  if (!RESOURCE_TYPES.has(resource.type)) throw new Error(`${pkgId}: unknown resource type: ${resource.type || "(missing)"}`);
  const next = { ...resource };
  if (next.type === "skill") {
    if (!isSlug(next.id)) throw new Error(`${pkgId}: skill resource needs slug id`);
    next.source = validateInsideSource(root, next.source, `${pkgId}:${next.id}`);
    if (!fs.existsSync(path.join(root, next.source, "SKILL.md"))) throw new Error(`${pkgId}:${next.id} source missing SKILL.md`);
    if (!SKILL_INVOCATIONS.has(next.invocation)) throw new Error(`${pkgId}:${next.id} invalid invocation`);
    if (next.risk && !["low", "medium", "high"].includes(next.risk)) throw new Error(`${pkgId}:${next.id} invalid risk`);
    next.entrypoints = (next.entrypoints || []).map((entrypoint) => normalizeSlashEntrypoint(entrypoint, pkgId, next.id));
    if (next.invocation === "manual" && !next.entrypoints.some((entrypoint) => entrypoint.type === "slash-command")) {
      throw new Error(`${pkgId}:${next.id} manual invocation requires a slash-command entrypoint`);
    }
  } else if (next.type === "slash-command") {
    if (!isSlug(next.id || next.name)) throw new Error(`${pkgId}: slash-command needs slug id/name`);
    next.name = String(next.name || next.id).replace(/^\//, "");
    next.source = validateInsideSource(root, next.source, `${pkgId}:/${next.name}`);
    if (!fs.existsSync(path.join(root, next.source))) throw new Error(`${pkgId}:/${next.name} source missing: ${next.source}`);
    validateHarnesses(next.harnesses, `${pkgId}:/${next.name}`, { requiredCapability: "slash-commands" });
  } else if (next.type === "permissions") {
    if (!Array.isArray(next.allow) || next.allow.length === 0) throw new Error(`${pkgId}: permissions resource needs non-empty allow array`);
    if (!next.allow.every((entry) => typeof entry === "string" && entry.trim() !== "")) {
      throw new Error(`${pkgId}: permissions.allow entries must be non-empty strings`);
    }
  } else if (next.type === "codex_tool_approvals") {
    if (typeof next.server !== "string" || next.server.trim() === "") throw new Error(`${pkgId}: codex_tool_approvals needs server`);
    if (!next.approvals || typeof next.approvals !== "object" || Array.isArray(next.approvals) || Object.keys(next.approvals).length === 0) {
      throw new Error(`${pkgId}: codex_tool_approvals needs non-empty approvals map`);
    }
  } else if (next.type === "mcp") {
    if (typeof next.preset !== "string" || next.preset.trim() === "") throw new Error(`${pkgId}: mcp resource needs preset`);
  } else if (next.type === "plugin") {
    if (typeof next.id !== "string" || next.id.trim() === "") throw new Error(`${pkgId}: plugin resource needs id`);
    if (!next.marketplace || typeof next.marketplace.name !== "string" || !next.marketplace.source) {
      throw new Error(`${pkgId}: plugin resource needs marketplace.name and marketplace.source`);
    }
  } else if (next.type === "service") {
    if (typeof next.id !== "string" || next.id.trim() === "") throw new Error(`${pkgId}: service resource needs id`);
  } else if (next.type === "harness-config") {
    next.source = validateInsideSource(root, next.source, `${pkgId}:harness-config`);
    if (!fs.existsSync(path.join(root, next.source))) throw new Error(`${pkgId}:harness-config source missing: ${next.source}`);
    validateHarness(next.harness, `${pkgId}:harness-config`, { requiredCapability: "package-config" });
  } else if (next.type === "package-runtime-asset") {
    next.source = validateInsideSource(root, next.source, `${pkgId}:package-runtime-asset`);
    if (!fs.existsSync(path.join(root, next.source))) throw new Error(`${pkgId}:package-runtime-asset source missing: ${next.source}`);
    if (next.target !== undefined && !isSafeRelativeTarget(next.target)) {
      throw new Error(`${pkgId}:package-runtime-asset target must be a relative path`);
    }
  } else if (next.type === "rules" || next.type === "hooks") {
    next.source = validateInsideSource(root, next.source, `${pkgId}:${next.type}`);
    if (!fs.existsSync(path.join(root, next.source))) throw new Error(`${pkgId}:${next.type} source missing: ${next.source}`);
    validateHarness(next.harness, `${pkgId}:${next.type}`, { allowBoth: true, requiredCapability: next.type });
    if (next.type === "hooks" && next.scripts !== undefined) {
      if (!Array.isArray(next.scripts)) throw new Error(`${pkgId}:hooks scripts must be an array`);
      next.scripts = next.scripts.map((script) => {
        const rel = validateInsideSource(root, script, `${pkgId}:hooks script`);
        if (!fs.existsSync(path.join(root, rel))) throw new Error(`${pkgId}:hooks script missing: ${rel}`);
        return rel;
      });
    }
  } else if (next.type === "cli-command") {
    if (!isCommandName(next.name)) throw new Error(`${pkgId}: CLI command resource needs name`);
  }
  return next;
}

function normalizeSlashEntrypoint(entrypoint, pkgId, skillId) {
  if (!entrypoint || entrypoint.type !== "slash-command") throw new Error(`${pkgId}:${skillId} entrypoint must be slash-command`);
  const name = String(entrypoint.name || "").replace(/^\//, "");
  if (!isSlug(name)) throw new Error(`${pkgId}:${skillId} entrypoint has invalid command name`);
  // Description is optional here: when absent (or left as a copy of the package description), the
  // generated command falls back to the skill's SKILL.md frontmatter — the agent-facing single
  // source of truth. A genuinely different override may still be set explicitly.
  const description = entrypoint.description === undefined ? undefined : String(entrypoint.description).trim() || undefined;
  if (description !== undefined && (description.includes("\n") || description === "")) {
    throw new Error(`${pkgId}:/${name} needs a one-line description`);
  }
  validateHarnesses(entrypoint.harnesses, `${pkgId}:/${name}`, { requiredCapability: "slash-commands" });
  return { ...entrypoint, name, description };
}

function componentResource(resource, root) {
  if (resource.type === "cli-command") return { ...resource, type: "command" };
  if (resource.type === "slash-command") return null;
  if (resource.type === "skill") return { type: "skill", id: resource.id };
  if (resource.source) {
    const rewritten = {
      ...resource,
      source: path.relative(repoRoot, path.join(root, resource.source)).split(path.sep).join("/"),
    };
    if (Array.isArray(resource.scripts)) {
      rewritten.scripts = resource.scripts.map((script) =>
        path.relative(repoRoot, path.join(root, script)).split(path.sep).join("/"));
    }
    return rewritten;
  }
  return resource;
}

function validateInsideSource(root, relSource, label) {
  if (typeof relSource !== "string" || relSource.trim() === "") throw new Error(`${label} source is required`);
  const resolved = path.resolve(root, relSource);
  const relative = path.relative(root, resolved);
  if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error(`${label} source must stay inside package directory`);
  }
  return relative.split(path.sep).join("/");
}

// requiredCapability, when given, is checked against the target harness's provider manifest so a
// resource can't silently target a harness that doesn't support what the resource type needs (e.g.
// a hooks resource pointed at a harness whose manifest doesn't declare the "hooks" capability).
// With today's two providers (claude/codex) both declaring the same capability set this never
// fires, but it becomes real protection the moment a narrower-capability harness is registered.
function validateHarness(harness, label, { allowBoth = false, requiredCapability } = {}) {
  if (allowBoth && harness === "both") return;
  if (!hasHarnessProvider(harness)) throw new Error(`${label} unknown harness: ${harness || "(missing)"}`);
  if (requiredCapability && !getHarnessProvider(harness).manifest.capabilities.includes(requiredCapability)) {
    throw new Error(`${label} harness "${harness}" does not support required capability: ${requiredCapability}`);
  }
}

function validateHarnesses(harnesses, label, { requiredCapability } = {}) {
  if (!Array.isArray(harnesses) || harnesses.length === 0) throw new Error(`${label} needs harnesses`);
  const seen = new Set();
  for (const harness of harnesses) {
    validateHarness(harness, label, { requiredCapability });
    if (seen.has(harness)) throw new Error(`${label} duplicate harness: ${harness}`);
    seen.add(harness);
  }
}

function claim(map, id, owner, errors, label) {
  if (!id) return;
  const previous = map.get(id);
  if (previous && previous !== owner) errors.push(`${label} ${id} owned by multiple packages: ${previous}, ${owner}`);
  map.set(id, owner);
}

function dependencyCycleErrors(packages) {
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const errors = [];
  const visiting = new Set();
  const visited = new Set();
  function visit(id, stack = []) {
    if (visited.has(id)) return;
    if (visiting.has(id)) {
      errors.push(`package dependency cycle: ${[...stack, id].join(" -> ")}`);
      return;
    }
    visiting.add(id);
    for (const dep of byId.get(id)?.requires || []) {
      if (byId.has(dep)) visit(dep, [...stack, id]);
    }
    visiting.delete(id);
    visited.add(id);
  }
  for (const pkg of packages) visit(pkg.id);
  return errors;
}

function packageSort(a, b) {
  return (
    a.presentation.category.localeCompare(b.presentation.category) ||
    a.presentation.order - b.presentation.order ||
    a.label.localeCompare(b.label) ||
    a.id.localeCompare(b.id)
  );
}

function isSlug(value) {
  return SLUG_RE.test(String(value || ""));
}

function isCommandName(value) {
  return typeof value === "string" && value.trim() !== "" && value.split(/\s+/).every(isSlug);
}

function isSafeRelativeTarget(value) {
  if (typeof value !== "string" || value.trim() === "") return false;
  const normalized = path.normalize(value);
  return normalized !== "." && !normalized.startsWith("..") && !path.isAbsolute(normalized);
}
