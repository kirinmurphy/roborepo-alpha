// Read-only inventory of the agent configuration a repo carries in its primary local checkout: the
// Claude Code and Codex instructions, skills, and configuration files found there, whether or not
// this machine runs that harness. Backs GET /api/config/repository and /api/config/repository/source.
//
// Ownership: providers (scripts/harnesses/*/project-inventory.mjs) name native paths and extract safe
// display metadata from text handed to them. This module owns everything that touches the disk:
// choosing the checkout, the bounded walk, confinement, Git classification, and token estimates.
//
// Nothing here writes. Git runs through the hardened helper with optional locks off, and only
// subcommands that cannot start a repo-configured process (no `status`, which can run clean
// filters). Modification is decided by hashing the working file in-process against the index blob;
// when a conversion attribute or CR bytes make that comparison unreliable, the label is omitted.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import {
  canonicalRepositoryId, resolveProjectIdentity, resolveGitDir, mainCheckoutPath, realpathOf,
} from "../../modules/repositories/identity.mjs";
import { resolveRegistryAlias } from "../../modules/repositories/schema.mjs";
import { defaultRunGit } from "../../modules/repositories/git-exec.mjs";
import { createHarnessRuntime } from "../harnesses/harness-runtime.mjs";
import { estimateTokens, classifyStartupLevel, classifyOnDemandLevel } from "./context-cost.mjs";

export const INVENTORY_LIMITS = Object.freeze({
  maxDepth: 12,
  maxEntriesVisited: 20000,
  maxFiles: 400,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  previewBytes: 256 * 1024,
});

// Dependency trees, build outputs, and caches: large, generated, and never a source of a repo's own
// agent configuration.
const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".gradle", ".venv", "venv",
  "__pycache__", ".terraform", "Pods", ".yarn", ".pnpm-store",
]);

const GIT_TIMEOUT_MS = 5000;
const GIT_BATCH = 200;
const CONVERSION_ATTRIBUTES = ["filter", "text", "eol", "ident", "working-tree-encoding"];

// --------------------------------------------------------------------------- checkout selection

// The repo's primary checkout, or why there is none. Never substitutes a secondary clone or a
// linked worktree for a designated primary that cannot be used.
export function selectPrimaryCheckout(registry, repositoryId, { fsApi = fs } = {}) {
  const record = registry?.repositories?.[repositoryId];
  if (!record) return unavailable("unknown", "This repo is not in the repo list.");
  const roots = record.localRoots || [];
  const pathFor = (root) => {
    const entry = registry.localRootPaths?.[root.rootId];
    return entry && entry.repositoryId === repositoryId ? entry.path : null;
  };
  const primaries = roots.filter((root) => root.kind === "primary");
  if (primaries.length > 1) return unavailable("ambiguous", "More than one checkout is marked primary.");

  let family;
  if (primaries.length === 1) {
    const primaryPath = pathFor(primaries[0]);
    if (!primaryPath) return unavailable("no-path", "The primary checkout has no recorded location on this machine.");
    family = checkoutFamily(primaryPath, { fsApi });
    if (!family) return unavailable("missing", "The primary checkout is not a readable Git checkout.");
  } else {
    const paths = roots.map(pathFor).filter(Boolean);
    if (!paths.length) return unavailable("no-path", "No checkout of this repo is recorded on this machine.");
    const families = new Set(paths.map((candidate) => checkoutFamily(candidate, { fsApi })).filter(Boolean));
    if (families.size !== 1) {
      return unavailable(families.size ? "ambiguous" : "missing", families.size
        ? "This repo has several checkouts and none is marked primary."
        : "No recorded checkout of this repo is a readable Git checkout.");
    }
    [family] = families;
  }

  // The directory may have been reused for another repo since it was recorded.
  let identity = null;
  try {
    identity = canonicalRepositoryId(resolveProjectIdentity(family, "roborepo", { fsApi }));
  } catch {
    identity = null;
  }
  const resolved = identity ? safeAlias(registry, identity) : null;
  if (resolved !== repositoryId) {
    return unavailable("moved", "The recorded checkout now holds a different repo.");
  }
  return { ok: true, path: family, head: readHead(family, { fsApi }) };
}

function unavailable(reason, message) {
  return { ok: false, reason, message };
}

function safeAlias(registry, identity) {
  try {
    return resolveRegistryAlias(registry, identity);
  } catch {
    return null;
  }
}

// The main checkout of the Git family a path belongs to, found through Git's common directory.
function checkoutFamily(checkoutPath, { fsApi }) {
  try {
    if (!fsApi.statSync(checkoutPath).isDirectory()) return null;
  } catch {
    return null;
  }
  const main = mainCheckoutPath([checkoutPath], { fsApi });
  return main ? realpathOf(main, fsApi) : null;
}

// Branch or detached HEAD from the checkout's own HEAD file. No subprocess.
export function readHead(checkoutPath, { fsApi = fs } = {}) {
  const resolved = resolveGitDir(checkoutPath, { fsApi });
  if (!resolved) return { kind: "unknown" };
  let raw = "";
  try {
    raw = fsApi.readFileSync(path.join(resolved.gitDir, "HEAD"), "utf8").trim();
  } catch {
    return { kind: "unknown" };
  }
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
  if (ref) return { kind: "branch", name: ref[1] };
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(raw)) return { kind: "detached", sha: raw.slice(0, 12) };
  return { kind: "unknown" };
}

// --------------------------------------------------------------------------- providers

function inventoryProviders(runtime) {
  return runtime.projectInventoryProviders().map(({ provider, enabled, inventory }) => ({
    id: provider.id,
    displayName: provider.manifest.displayName,
    enabled,
    inventory,
    error: null,
  }));
}

function classifyWith(providers, relPath, options) {
  const matches = [];
  for (const provider of providers) {
    if (!provider.inventory || provider.error) continue;
    try {
      const match = provider.inventory.classify(relPath, options);
      if (match) matches.push({ provider, match });
    } catch (error) {
      provider.error = `Discovery failed: ${String(error?.message || error).slice(0, 160)}`;
    }
  }
  return matches;
}

// --------------------------------------------------------------------------- bounded walk

// Breadth-first, so a truncated scan still covers the root and the shallow folders where most
// configuration lives. Symlinks are never followed; a symlink that names a native source is listed
// as a reference. A subfolder with its own `.git` is another checkout and is skipped whole.
function walkCheckout(root, providers, limits) {
  const candidates = [];
  const truncated = new Set();
  let visited = 0;
  const queue = [{ rel: "", depth: 0 }];
  while (queue.length) {
    const { rel, depth } = queue.shift();
    let dirents;
    try {
      dirents = fs.readdirSync(rel ? path.join(root, rel) : root, { withFileTypes: true });
    } catch {
      continue;
    }
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      visited += 1;
      if (visited > limits.maxEntriesVisited) {
        truncated.add("entries");
        return { candidates, truncated: [...truncated] };
      }
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink()) {
        for (const found of classifyWith(providers, childRel, { symlink: true })) {
          candidates.push({ rel: childRel, symlink: true, ...found });
        }
        continue;
      }
      if (dirent.isDirectory()) {
        if (SKIPPED_DIRECTORIES.has(dirent.name)) continue;
        if (depth + 1 > limits.maxDepth) {
          truncated.add("depth");
          continue;
        }
        if (fs.existsSync(path.join(root, childRel, ".git"))) continue;
        queue.push({ rel: childRel, depth: depth + 1 });
        continue;
      }
      if (!dirent.isFile()) continue;
      for (const found of classifyWith(providers, childRel, { symlink: false })) {
        if (candidates.length >= limits.maxFiles) {
          truncated.add("files");
          return { candidates, truncated: [...truncated] };
        }
        candidates.push({ rel: childRel, symlink: false, ...found });
      }
    }
  }
  return { candidates, truncated: [...truncated] };
}

// --------------------------------------------------------------------------- confinement

// A relative path from a request or a walk, as a list of plain segments, or null.
function cleanSegments(relPath) {
  if (typeof relPath !== "string" || !relPath || relPath.length > 1024) return null;
  if (relPath.includes("\\") || relPath.includes("\0") || relPath.startsWith("/")) return null;
  const parts = relPath.split("/");
  if (parts.some((part) => !part || part === "." || part === "..")) return null;
  return parts;
}

// Whether the walk could have reached these segments: no skipped folder on the way and no deeper
// than its depth limit. A preview names only what the inventory could list.
function withinWalk(parts, limits) {
  if (!parts) return false;
  const folders = parts.slice(0, -1);
  return folders.length <= limits.maxDepth && !folders.some((folder) => SKIPPED_DIRECTORIES.has(folder));
}

// Reads a regular file inside the checkout, rechecking at read time that every parent is a real
// directory of this checkout (no symlink, no nested `.git`) and the file is not a symlink.
// Returns { ok, buffer, size, complete } or { ok: false, diagnostic }.
export function readConfinedFile(root, relPath, maxBytes) {
  const parts = cleanSegments(relPath);
  if (!parts) return { ok: false, diagnostic: "Not a path inside this checkout." };
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = fs.lstatSync(current);
    } catch {
      return { ok: false, diagnostic: "The file is no longer there." };
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return { ok: false, diagnostic: "The path leaves this checkout." };
    if (fs.existsSync(path.join(current, ".git"))) return { ok: false, diagnostic: "The path is inside another checkout." };
  }
  const filePath = path.join(root, ...parts);
  let fd;
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return { ok: false, diagnostic: "This is a symbolic link; its target is not read." };
    if (!stat.isFile()) return { ok: false, diagnostic: "Not a regular file." };
    const real = fs.realpathSync(filePath);
    if (!real.startsWith(root + path.sep)) return { ok: false, diagnostic: "The path leaves this checkout." };
    fd = fs.openSync(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const read = fs.readSync(fd, buffer, offset, length - offset, offset);
      if (read === 0) break;
      offset += read;
    }
    return { ok: true, buffer: buffer.subarray(0, offset), size: stat.size, complete: stat.size <= maxBytes };
  } catch {
    return { ok: false, diagnostic: "Could not read this file." };
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
}

// --------------------------------------------------------------------------- Git classification

function splitZ(stdout) {
  return String(stdout || "").split("\0").filter(Boolean);
}

function chunks(values, size) {
  const out = [];
  for (let index = 0; index < values.length; index += size) out.push(values.slice(index, index + size));
  return out;
}

// relPath -> { status: "tracked" | "untracked" | "ignored" | "unavailable", blob?, mode? }.
async function classifyGitStatus(root, relPaths, { runGit = defaultRunGit } = {}) {
  const result = new Map(relPaths.map((rel) => [rel, { status: "unavailable" }]));
  if (!relPaths.length || !resolveGitDir(root)) return { statuses: result, attributes: new Map() };
  const attributes = new Map();
  const run = (args) => runGit(root, args, { timeoutMs: GIT_TIMEOUT_MS });
  for (const batch of chunks(relPaths, GIT_BATCH)) {
    const specs = batch.map((rel) => `:(literal)${rel}`);
    const [cached, others, ignored, attrs] = await Promise.all([
      run(["ls-files", "-z", "-s", "--", ...specs]),
      run(["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]),
      run(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...specs]),
      run(["check-attr", "-z", ...CONVERSION_ATTRIBUTES, "--", ...batch]),
    ]);
    if (cached.ok) {
      for (const line of splitZ(cached.stdout)) {
        const match = /^(\d+) ([0-9a-f]+) \d\t(.+)$/.exec(line);
        if (match && result.has(match[3])) result.set(match[3], { status: "tracked", mode: match[1], blob: match[2] });
      }
    }
    for (const [run, status] of [[others, "untracked"], [ignored, "ignored"]]) {
      if (!run.ok) continue;
      for (const rel of splitZ(run.stdout)) {
        if (result.has(rel) && result.get(rel).status !== "tracked") result.set(rel, { status });
      }
    }
    if (attrs.ok) {
      const fields = String(attrs.stdout).split("\0");
      for (let index = 0; index + 2 < fields.length; index += 3) {
        const [rel, , value] = fields.slice(index, index + 3);
        if (value && value !== "unspecified") attributes.set(rel, true);
      }
    }
  }
  // A failed query leaves its paths "unavailable" rather than guessing a status.
  return { statuses: result, attributes };
}

// True or false when the in-process hash comparison is reliable; null when it is not.
function localModification(git, buffer, complete, converted) {
  if (git.status !== "tracked" || !git.blob || git.mode === "120000" || !buffer || !complete) return null;
  const algorithm = git.blob.length === 64 ? "sha256" : "sha1";
  const hash = createHash(algorithm).update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
  if (hash === git.blob) return false;
  if (converted || buffer.includes(0x0d)) return null;
  return true;
}

// --------------------------------------------------------------------------- inventory

// A root-level file is weighed like startup context; anything loaded later like on-demand context.
function tokenLevel(tokens, loading) {
  return loading === "root-level" ? classifyStartupLevel(tokens) : classifyOnDemandLevel(tokens);
}

function entryId(harness, relPath) {
  return `${harness}:${relPath}`;
}

function describeWith(provider, record, text) {
  try {
    return provider.inventory.describe(record, text) || {};
  } catch (error) {
    return { diagnostic: `Could not summarize: ${String(error?.message || error).slice(0, 160)}` };
  }
}

function textOf(buffer) {
  return buffer.toString("utf8");
}

export async function loadRepositoryAgentConfig({
  registry, repositoryId, runtime = createHarnessRuntime(), limits = INVENTORY_LIMITS, runGit,
} = {}) {
  const record = registry?.repositories?.[repositoryId];
  const base = { repositoryId, displayName: record?.displayName || null };
  const checkout = selectPrimaryCheckout(registry, repositoryId);
  const providers = inventoryProviders(runtime);
  const providerSummary = () => providers.map((provider) => ({
    id: provider.id,
    displayName: provider.displayName,
    supported: !!provider.inventory,
    enabled: provider.enabled,
    ...(provider.error ? { error: provider.error } : {}),
  }));
  if (!checkout.ok) {
    return { ...base, status: "checkout-unavailable", reason: checkout.reason, message: checkout.message, providers: providerSummary() };
  }

  const root = checkout.path;
  const { candidates, truncated } = walkCheckout(root, providers, limits);
  const relPaths = [...new Set(candidates.map((candidate) => candidate.rel))];
  const { statuses, attributes } = await classifyGitStatus(root, relPaths, { runGit });

  let bytesRead = 0;
  const reads = new Map();
  const readOnce = (rel) => {
    if (reads.has(rel)) return reads.get(rel);
    let read;
    if (bytesRead >= limits.maxTotalBytes) {
      read = { ok: false, diagnostic: "Not read: the scan reached its size budget." };
      truncated.push("bytes");
    } else {
      read = readConfinedFile(root, rel, Math.min(limits.maxFileBytes, limits.maxTotalBytes - bytesRead));
      if (read.ok) bytesRead += read.buffer.length;
    }
    reads.set(rel, read);
    return read;
  };

  const entries = candidates.map(({ rel, symlink, provider, match }) => {
    const git = statuses.get(rel) || { status: "unavailable" };
    const parts = rel.split("/");
    const entry = {
      id: entryId(provider.id, rel),
      harness: provider.id,
      harnessName: provider.displayName,
      area: match.area,
      kind: match.kind,
      label: match.label,
      path: rel,
      folder: parts.length > 1 ? parts.slice(0, -1).join("/") : "",
      loading: match.loading,
      format: match.format,
      name: match.name ?? null,
      description: null,
      ...(match.override ? { override: true } : {}),
      ...(match.legacy ? { legacy: true } : {}),
      ...(match.note ? { note: match.note } : {}),
      symlink,
      git: { status: git.status },
      tokens: null,
      size: null,
    };
    if (symlink) return entry;
    // A skill's own file is its SKILL.md; the folder is the skill.
    const read = readOnce(rel);
    if (!read.ok) return { ...entry, diagnostic: read.diagnostic };
    entry.size = read.size;
    const modified = localModification(git, read.buffer, read.complete, attributes.has(rel));
    if (modified !== null) entry.git.modified = modified;
    if (!read.complete) return { ...entry, diagnostic: "Larger than the inspector reads; metadata is unavailable." };
    const text = textOf(read.buffer);
    if (match.format === "text") entry.tokens = estimateTokens(text).tokens;
    const described = describeWith(provider, match, text);
    const loading = described.loading ?? entry.loading;
    return {
      ...entry,
      name: described.name ?? entry.name,
      description: described.description ?? null,
      loading,
      ...(entry.tokens !== null ? { tokenLevel: tokenLevel(entry.tokens, loading) } : {}),
      ...(described.sections?.length ? { sections: described.sections.map(String) } : {}),
      ...(described.diagnostic ? { diagnostic: String(described.diagnostic) } : {}),
    };
  });

  return {
    ...base,
    status: "ok",
    checkout: { path: root, head: checkout.head },
    truncated: [...new Set(truncated)],
    providers: providerSummary(),
    entries,
  };
}

// One inventory entry's preview: the text body for instructions, skills, agents, and commands; the
// safe summary for structured configuration. The entry id is rechecked against the provider and the
// disk at read time, so a request can only name a file the inventory would list.
export async function loadRepositoryAgentConfigSource({
  registry, repositoryId, id, runtime = createHarnessRuntime(), limits = INVENTORY_LIMITS, runGit,
} = {}) {
  const separator = typeof id === "string" ? id.indexOf(":") : -1;
  if (separator < 1) return { ok: false, status: 400, error: "expected an inventory entry id" };
  const harness = id.slice(0, separator);
  const rel = id.slice(separator + 1);
  const checkout = selectPrimaryCheckout(registry, repositoryId);
  if (!checkout.ok) return { ok: false, status: 409, error: checkout.message, reason: checkout.reason };
  const provider = inventoryProviders(runtime).find((candidate) => candidate.id === harness && candidate.inventory);
  if (!provider || !withinWalk(cleanSegments(rel), limits)) return { ok: false, status: 404, error: "Not an inventory entry." };
  const [found] = classifyWith([provider], rel, { symlink: false });
  if (!found) return { ok: false, status: 404, error: "Not an inventory entry." };
  const match = found.match;
  const read = readConfinedFile(checkout.path, rel, Math.max(limits.previewBytes, limits.maxFileBytes));
  if (!read.ok) return { ok: false, status: 404, error: read.diagnostic };
  const { statuses, attributes } = await classifyGitStatus(checkout.path, [rel], { runGit });
  const gitStatus = statuses.get(rel) || { status: "unavailable" };
  const git = { status: gitStatus.status };
  const modified = localModification(gitStatus, read.buffer, read.complete, attributes.has(rel));
  if (modified !== null) git.modified = modified;
  const text = textOf(read.buffer);
  const described = read.complete ? describeWith(provider, match, text) : {};
  const response = {
    ok: true,
    id,
    harness,
    harnessName: provider.displayName,
    path: rel,
    title: described.name || match.name || rel.split("/").at(-1),
    label: match.label,
    area: match.area,
    format: match.format,
    git,
    size: read.size,
  };
  if (match.format !== "text") {
    return { ...response, sections: described.sections || [], ...(described.diagnostic ? { diagnostic: described.diagnostic } : {}) };
  }
  const shown = text.length > limits.previewBytes ? text.slice(0, limits.previewBytes) : text;
  return {
    ...response,
    content: shown,
    truncated: !read.complete || shown.length < text.length,
    tokens: read.complete ? estimateTokens(text).tokens : null,
    loading: described.loading ?? match.loading,
  };
}
