// The git package source: packages from a public GitHub repository, pinned to a commit.
//
// Discovery and installation are separate steps. Refreshing a source fetches one commit into the
// managed cache, turns what it finds into RoboRepo-shaped package folders, and writes the source's
// catalog; nothing is installed or applied. Installing copies one of those folders into the install
// store (package-install-store.mjs). After that the package works offline: the catalog reads the
// installed copy, never the network.
//
// A repo without RoboRepo manifests still yields packages. The repo's own files decide how its
// skills are grouped, so the same commit always groups the same way:
//   package.config.json files       RoboRepo packages, as declared
//   .claude-plugin/plugin.json      one package holding every skill in the plugin
//   skills/*/SKILL.md (or SKILL.md) one package per skill; two or more form a collection
//
// v1 reaches public GitHub repositories over HTTPS with no authentication. A file:// URL is also
// accepted, for a local mirror or clone.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { appRoot } from "./roots.mjs";
import { cacheDir, catalogsDir, hashPackageTree } from "./package-install-store.mjs";
import { createPackageSource, readManifest, registerSourceAdapter } from "./package-source-adapters.mjs";
import { writeJsonStateAtomic } from "./state-paths.mjs";
import { PackageSourceError } from "./package-sources.mjs";

export const GIT_CATALOG_SCHEMA_VERSION = 1;
export const TRUSTED_CATALOG_PATH = path.join(appRoot, "manifests", "inventory", "trusted-package-sources.json");
// Packages synthesized from skill folders or plugins land in this catalog category.
export const ADDED_SKILLS_CATEGORY = "added-skills";

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;
const SHA_RE = /^[0-9a-f]{40}$/;
const SCRIPT_EXTENSIONS = new Set([".sh", ".bash", ".zsh", ".py", ".js", ".cjs", ".mjs", ".ts", ".rb", ".pl", ".ps1", ".bat", ".cmd"]);

// ---------------------------------------------------------------------------------------------
// URLs

// Returns { url, display, defaultId } for a supported repository reference, or throws.
export function normalizeGitUrl(input) {
  const text = String(input || "").trim();
  if (text.startsWith("file://")) {
    const repoPath = decodeURIComponent(new URL(text).pathname);
    const name = path.basename(repoPath).replace(/\.git$/, "");
    return { url: text.replace(/\/+$/, ""), display: repoPath, defaultId: slugify(name) };
  }
  const match = /^(?:https:\/\/)?(?:www\.)?github\.com\/([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?\/?$/.exec(text);
  if (!match) {
    throw new PackageSourceError(`unsupported repository URL: ${text || "(empty)"}. Use https://github.com/<owner>/<repo>`, { code: "invalid-url" });
  }
  const [, owner, repo] = match;
  return { url: `https://github.com/${owner}/${repo}.git`, display: `${owner}/${repo}`, defaultId: slugify(`${owner}-${repo}`) };
}

function slugify(value) {
  return String(value).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "") || "source";
}

// ---------------------------------------------------------------------------------------------
// Trusted catalog: vetted repos, each pinned to a reviewed commit, shipped with the application.

export function readTrustedCatalog(file = TRUSTED_CATALOG_PATH) {
  let data;
  try {
    data = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if (err?.code === "ENOENT") return [];
    throw new Error(`invalid trusted package catalog ${file}: ${err.message}`);
  }
  if (data?.schemaVersion !== 1 || !Array.isArray(data.entries)) {
    throw new Error("trusted package catalog must contain { schemaVersion: 1, entries: [...] }");
  }
  return data.entries.map((entry, index) => {
    const label = `trusted package catalog entry ${index + 1}`;
    if (!SHA_RE.test(String(entry?.commit || ""))) throw new Error(`${label}: commit must be a full commit SHA`);
    if (typeof entry.description !== "string" || entry.description.trim() === "") throw new Error(`${label}: description is required`);
    const normalized = normalizeGitUrl(entry.repo);
    return { repo: entry.repo, url: normalized.url, display: normalized.display, defaultId: normalized.defaultId, commit: entry.commit, description: entry.description };
  });
}

export function trustedEntryFor(url, entries = readTrustedCatalog()) {
  return entries.find((entry) => entry.url === url) || null;
}

// ---------------------------------------------------------------------------------------------
// Git transport

function git(args, { cwd } = {}) {
  const result = spawnSync("git", ["-c", "credential.helper=", ...args], {
    cwd,
    encoding: "utf8",
    // Never stop for a username prompt: a private or missing repo fails instead of hanging.
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: "", SSH_ASKPASS: "" },
  });
  if (result.error) throw new PackageSourceError(`git is not available: ${result.error.message}`, { code: "unavailable" });
  return result;
}

// The commit the repository's default branch points at.
export function resolveHeadCommit(url) {
  const result = git(["ls-remote", url, "HEAD"]);
  const sha = result.status === 0 ? result.stdout.split(/\s+/)[0] : "";
  if (!SHA_RE.test(sha)) {
    const reason = (result.stderr || "").trim().split("\n").at(-1) || "no default branch";
    throw new PackageSourceError(`cannot reach ${url}: ${reason}`, { code: "unavailable" });
  }
  return sha;
}

// Check out exactly `sha` into `dest` (which must not exist) without keeping Git metadata.
function fetchCommit(url, sha, dest) {
  const gitDir = `${dest}.git-tmp`;
  fs.rmSync(gitDir, { recursive: true, force: true });
  try {
    const init = git(["init", "-q", "--bare", gitDir]);
    if (init.status !== 0) throw new PackageSourceError(`git init failed: ${init.stderr.trim()}`);
    // Fetch the one commit; a server that refuses fetch-by-SHA gets a full fetch of its branches.
    let fetched = git(["--git-dir", gitDir, "fetch", "-q", "--depth", "1", url, sha]);
    if (fetched.status !== 0) fetched = git(["--git-dir", gitDir, "fetch", "-q", url, "+refs/heads/*:refs/heads/*"]);
    if (fetched.status !== 0) {
      throw new PackageSourceError(`cannot fetch ${url}: ${fetched.stderr.trim().split("\n").at(-1)}`, { code: "unavailable" });
    }
    if (git(["--git-dir", gitDir, "cat-file", "-e", `${sha}^{commit}`]).status !== 0) {
      throw new PackageSourceError(`${url} has no commit ${sha}`, { code: "unavailable" });
    }
    fs.mkdirSync(dest, { recursive: true });
    const checkout = git(["--git-dir", gitDir, "--work-tree", dest, "checkout", "-q", "-f", sha, "--", "."], { cwd: dest });
    if (checkout.status !== 0) throw new PackageSourceError(`cannot check out ${sha}: ${checkout.stderr.trim()}`);
  } catch (err) {
    fs.rmSync(dest, { recursive: true, force: true });
    throw err;
  } finally {
    fs.rmSync(gitDir, { recursive: true, force: true });
  }
}

// ---------------------------------------------------------------------------------------------
// Scanning a checked-out tree into packages

// Returns [{ packageId, build(destDir), collection }] for the formats the tree contains.
export function scanSourceTree(tree, { sourceId, display }) {
  refuseSymlinks(tree);
  const manifests = roboRepoManifests(tree);
  if (manifests.length > 0) {
    return manifests.map((dir) => ({
      packageId: readManifest(path.join(dir, "package.config.json")).id,
      collection: null,
      build: (dest) => fs.cpSync(dir, dest, { recursive: true, filter: (src) => path.basename(src) !== ".git" }),
    }));
  }
  const pluginFile = path.join(tree, ".claude-plugin", "plugin.json");
  if (fs.existsSync(pluginFile)) return [pluginPackage(tree, pluginFile, display, sourceId)];
  const skills = skillFolders(tree, sourceId);
  if (skills.length === 0) throw new PackageSourceError(`${display} has no packages: no package.config.json, .claude-plugin/plugin.json, or skills/*/SKILL.md`, { code: "no-packages" });
  const collection = skills.length >= 2 ? { id: sourceId, title: display } : null;
  return skills.map((skill) => ({
    packageId: skill.id,
    collection,
    build: (dest) => {
      fs.mkdirSync(path.join(dest, "skills"), { recursive: true });
      fs.cpSync(skill.dir, path.join(dest, "skills", skill.id), { recursive: true });
      writeSynthesizedConfig(dest, {
        id: skill.id,
        label: titleize(skill.id),
        description: skill.description || `The ${skill.id} skill from ${display}.`,
        skills: [skill.id],
      });
    },
  }));
}

function roboRepoManifests(tree) {
  if (fs.existsSync(path.join(tree, "package.config.json"))) return [tree];
  const dirs = [];
  for (const parent of [tree, path.join(tree, "packages")]) {
    for (const entry of safeReaddir(parent)) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      const dir = path.join(parent, entry.name);
      if (fs.existsSync(path.join(dir, "package.config.json"))) dirs.push(dir);
    }
  }
  return dirs.sort();
}

function pluginPackage(tree, pluginFile, display, sourceId) {
  const plugin = readManifest(pluginFile);
  const id = slugify(plugin.name || sourceId);
  const skills = skillFolders(tree, sourceId);
  if (skills.length === 0) throw new PackageSourceError(`${display}: plugin ${id} has no skills RoboRepo can install`, { code: "no-packages" });
  return {
    packageId: id,
    collection: null,
    build: (dest) => {
      fs.mkdirSync(path.join(dest, "skills"), { recursive: true });
      for (const skill of skills) fs.cpSync(skill.dir, path.join(dest, "skills", skill.id), { recursive: true });
      // Plugin hooks and commands are listed in the contents summary but not installed; keep them
      // beside the package so the summary can name them.
      for (const extra of ["hooks", "commands"]) {
        if (fs.existsSync(path.join(tree, extra))) fs.cpSync(path.join(tree, extra), path.join(dest, "plugin", extra), { recursive: true });
      }
      writeSynthesizedConfig(dest, {
        id,
        label: typeof plugin.name === "string" ? plugin.name : titleize(id),
        description: oneLine(plugin.description) || `The ${id} plugin from ${display}.`,
        skills: skills.map((skill) => skill.id),
      });
    },
  };
}

// A repo whose root is one skill is named by the skill's frontmatter `name`, or by its source.
function skillFolders(tree, sourceId) {
  if (fs.existsSync(path.join(tree, "SKILL.md"))) {
    const { name, description } = readSkillFrontmatter(path.join(tree, "SKILL.md"));
    const id = SLUG_RE.test(name) ? name : sourceId;
    return [{ id, dir: tree, description }];
  }
  return safeReaddir(path.join(tree, "skills"))
    .filter((entry) => entry.isDirectory() && fs.existsSync(path.join(tree, "skills", entry.name, "SKILL.md")))
    .map((entry) => ({ id: entry.name, dir: path.join(tree, "skills", entry.name) }))
    .filter((skill) => SLUG_RE.test(skill.id))
    .map((skill) => ({ ...skill, description: readSkillFrontmatter(path.join(skill.dir, "SKILL.md")).description }))
    .sort((a, b) => a.id.localeCompare(b.id));
}

function writeSynthesizedConfig(dest, { id, label, description, skills }) {
  fs.writeFileSync(path.join(dest, "package.config.json"), `${JSON.stringify({
    schemaVersion: 1,
    id,
    label,
    description,
    presentation: { category: ADDED_SKILLS_CATEGORY },
    resources: skills.map((skill) => ({ type: "skill", id: skill, source: `skills/${skill}`, invocation: "auto", risk: "medium" })),
  }, null, 2)}\n`);
}

// `name` and a one-line `description` from SKILL.md frontmatter, including a folded (`>`) or
// literal (`|`) description.
function readSkillFrontmatter(file) {
  const text = fs.readFileSync(file, "utf8");
  const frontmatter = /^---\r?\n([\s\S]*?)\r?\n---/.exec(text)?.[1] || "";
  const lines = frontmatter.split(/\r?\n/);
  const field = (key) => {
    const index = lines.findIndex((line) => line.startsWith(`${key}:`));
    if (index === -1) return "";
    let value = lines[index].slice(key.length + 1).trim();
    if (/^[>|][-+]?$/.test(value)) {
      const rest = lines.slice(index + 1);
      const end = rest.findIndex((line) => !/^\s+\S/.test(line));
      value = (end === -1 ? rest : rest.slice(0, end)).map((line) => line.trim()).join(" ");
    }
    return oneLine(value.replace(/^["']|["']$/g, ""));
  };
  return { name: field("name"), description: field("description") };
}

function oneLine(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length > 280 ? `${text.slice(0, 277)}...` : text;
}

function titleize(id) {
  return id.split("-").map((part) => part.charAt(0).toUpperCase() + part.slice(1)).join(" ");
}

// A symlink in a fetched repo could point anywhere on this machine; copying it into a harness
// would expose that target. Such a repo is refused outright.
function refuseSymlinks(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true, recursive: true })) {
    if (entry.isSymbolicLink()) {
      throw new PackageSourceError(`refusing a repository that contains a symbolic link: ${path.relative(dir, path.join(entry.parentPath, entry.name))}`, { code: "unsafe" });
    }
  }
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// What a package will put on this machine, for the user to read before installing it.
export function contentsSummary(packageDir) {
  const config = readManifest(path.join(packageDir, "package.config.json"));
  const resources = Array.isArray(config.resources) ? config.resources : [];
  const of = (type) => resources.filter((resource) => resource.type === type);
  const files = listRelativeFiles(packageDir);
  return {
    skills: of("skill").map((resource) => resource.id),
    slashCommands: [...of("slash-command").map((r) => r.name || r.id), ...of("skill").flatMap((r) => (r.entrypoints || []).map((e) => e.name))],
    rules: of("rules").map((resource) => resource.source),
    hooks: of("hooks").map((resource) => `${resource.source} (${resource.harness})`),
    mcpServers: of("mcp").map((resource) => resource.preset),
    // Each config change by harness, operation, and setting path, so the user sees exactly which
    // settings (permissions included) a package would write.
    permissions: of("config-patch").flatMap((resource) => (Array.isArray(resource.patches) ? resource.patches : []).map((patch) =>
      `${resource.harness}: ${patch.op} ${(patch.path || []).join(".")}${resource.label ? ` (${resource.label})` : ""}`)),
    runtimeAssets: of("package-runtime-asset").map((resource) => resource.source),
    services: of("service").map((resource) => resource.id),
    scripts: files.filter((rel) => SCRIPT_EXTENSIONS.has(path.extname(rel)) || isExecutable(path.join(packageDir, rel))),
    notInstalled: files.filter((rel) => rel.startsWith("plugin/")),
    requires: Array.isArray(config.requires) ? config.requires : [],
  };
}

export function formatContentsSummary(summary) {
  const rows = [
    ["skills", summary.skills],
    ["slash commands", summary.slashCommands],
    ["rules", summary.rules],
    ["hooks", summary.hooks],
    ["MCP servers", summary.mcpServers],
    ["config changes", summary.permissions],
    ["runtime assets", summary.runtimeAssets || []],
    ["services", summary.services],
    ["scripts", summary.scripts],
    ["requires", summary.requires],
    ["plugin files not installed", summary.notInstalled],
  ];
  return rows.filter(([, items]) => items.length > 0).map(([label, items]) => `  ${label}: ${items.join(", ")}`);
}

function listRelativeFiles(dir, prefix = "") {
  const out = [];
  for (const entry of safeReaddir(path.join(dir, prefix))) {
    const rel = path.join(prefix, entry.name);
    if (entry.isDirectory()) out.push(...listRelativeFiles(dir, rel));
    else if (entry.isFile()) out.push(rel.split(path.sep).join("/"));
  }
  return out.sort();
}

function isExecutable(file) {
  try {
    return (fs.statSync(file).mode & 0o111) !== 0;
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------------------------
// Source catalog cache

export function catalogPathFor(sourceId) {
  return path.join(catalogsDir, `${sourceId}.json`);
}

export function revisionCacheDir(sourceId, revision) {
  return path.join(cacheDir, sourceId, revision);
}

// The last good listing of a git source, or null when it was never refreshed.
export function readGitCatalog(sourceId) {
  try {
    const data = JSON.parse(fs.readFileSync(catalogPathFor(sourceId), "utf8"));
    if (data?.schemaVersion !== GIT_CATALOG_SCHEMA_VERSION || !Array.isArray(data.packages)) return null;
    return data;
  } catch {
    return null;
  }
}

// Fetch `revision` (default: the trusted commit for a trusted source, else the default branch),
// build its packages into the cache, and replace the source's catalog. The previous catalog stays
// in place until the new one is complete, so a failed refresh changes nothing.
// A trusted source whose repo has left the trusted catalog is refused rather than moved to the
// branch head, which would put unreviewed content under a "Trusted" label.
export function refreshGitSource(record, { revision = null, validate = null } = {}) {
  let target = revision;
  if (!target && record.trust === "trusted") {
    target = trustedEntryFor(record.url)?.commit || null;
    if (!target) {
      throw new PackageSourceError(`${record.display || record.url} is no longer in the trusted catalog; remove the source and add it again to use it as unverified`, { code: "unavailable" });
    }
  }
  target ||= resolveHeadCommit(record.url);
  const current = readGitCatalog(record.id);
  if (current?.revision === target && fs.existsSync(revisionCacheDir(record.id, target))) {
    return { catalog: current, changed: false };
  }
  const revisionDir = revisionCacheDir(record.id, target);
  const building = `${revisionDir}.building-${process.pid}`;
  fs.rmSync(building, { recursive: true, force: true });
  try {
    const tree = path.join(building, "tree");
    fetchCommit(record.url, target, tree);
    const display = record.display || record.url;
    const found = scanSourceTree(tree, { sourceId: record.id, display });
    const packages = [];
    const seen = new Set();
    for (const item of found) {
      if (!SLUG_RE.test(String(item.packageId || ""))) throw new PackageSourceError(`${display}: invalid package id ${item.packageId}`);
      if (seen.has(item.packageId)) throw new PackageSourceError(`${display}: two packages named ${item.packageId}`);
      seen.add(item.packageId);
      const dest = path.join(building, "packages", item.packageId);
      fs.mkdirSync(dest, { recursive: true });
      item.build(dest);
      if (validate) validate(dest, item.packageId);
      // The content hash of what refresh built; install verifies its copy against it, so a cache
      // altered after refresh fails instead of installing.
      packages.push({ packageId: item.packageId, collection: item.collection, contents: contentsSummary(dest), integrity: hashPackageTree(dest) });
    }
    fs.rmSync(tree, { recursive: true, force: true });
    fs.rmSync(revisionDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(revisionDir), { recursive: true });
    fs.renameSync(building, revisionDir);
    const catalog = {
      schemaVersion: GIT_CATALOG_SCHEMA_VERSION,
      sourceId: record.id,
      url: record.url,
      revision: target,
      refreshedAt: new Date().toISOString(),
      packages,
    };
    writeJsonStateAtomic(catalogPathFor(record.id), catalog);
    return { catalog, changed: true, previousRevision: current?.revision || null };
  } finally {
    fs.rmSync(building, { recursive: true, force: true });
  }
}

// Drop cached revisions nothing points at: not the catalog's current revision, and not one an
// installed package still records.
export function pruneGitCache(sourceId, keepRevisions) {
  const keep = new Set(keepRevisions.filter(Boolean));
  for (const entry of safeReaddir(path.join(cacheDir, sourceId))) {
    if (entry.isDirectory() && !keep.has(entry.name)) fs.rmSync(path.join(cacheDir, sourceId, entry.name), { recursive: true, force: true });
  }
}

export function forgetGitSourceCache(sourceId) {
  fs.rmSync(path.join(cacheDir, sourceId), { recursive: true, force: true });
  fs.rmSync(catalogPathFor(sourceId), { force: true });
}

// The adapter reads only the cache, so listing a git source never touches the network.
function gitSource(record) {
  const entries = () => {
    const catalog = readGitCatalog(record.id);
    if (!catalog) return [];
    // A listing whose cached files were deleted offers nothing until the next refresh, rather than
    // breaking every listing of every source.
    return catalog.packages.flatMap((item) => {
      const root = path.join(revisionCacheDir(record.id, catalog.revision), "packages", item.packageId);
      const file = path.join(root, "package.config.json");
      if (!fs.existsSync(file)) return [];
      return { sourceId: record.id, packageId: item.packageId, root, file, config: readManifest(file), collection: item.collection, revision: catalog.revision, contents: item.contents, integrity: item.integrity || null };
    });
  };
  return createPackageSource({
    id: record.id,
    kind: "git",
    list: entries,
    resolve(packageId) {
      const entry = entries().find((candidate) => candidate.packageId === packageId);
      if (!entry) return null;
      return {
        sourceId: record.id,
        packageId,
        sourceType: "git",
        trust: record.trust,
        kind: "materialized",
        selector: record.trust === "trusted" ? "trusted-catalog" : "default-branch",
        resolved: entry.revision,
        integrity: entry.integrity,
        url: record.url,
      };
    },
    materialize(resolution) {
      const dir = path.join(revisionCacheDir(record.id, resolution.resolved), "packages", resolution.packageId);
      if (!fs.existsSync(path.join(dir, "package.config.json"))) {
        throw new PackageSourceError(`${record.id}/${resolution.packageId}: revision ${resolution.resolved} is not in the cache; run \`roborepo package source refresh ${record.id}\``, { code: "unavailable" });
      }
      return dir;
    },
  });
}

registerSourceAdapter("git", gitSource);
