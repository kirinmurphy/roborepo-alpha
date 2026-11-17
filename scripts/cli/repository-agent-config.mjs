// Read-only inventory of the agent configuration a repo carries in its primary local checkout: the
// Claude Code and Codex instructions, skills, and configuration files found there, whether or not
// this machine runs that harness. Backs GET /api/config/repository and /api/config/repository/source.
//
// Ownership: providers (scripts/harnesses/*/project-inventory.mjs) name native paths, extract safe
// display metadata from text handed to them, and say which files a session reads at start. This
// module owns everything that touches the disk: choosing the checkout, the bounded walk,
// confinement, Git classification, and token estimates.
//
// The walk and every file read are asynchronous and bounded, so a large checkout never holds the
// portal's event loop. A symlink is read only when it resolves to a file the walk itself could list
// inside this checkout; anything pointing elsewhere is listed as a reference and never read.
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
import { defaultRunGit, defaultRunGitSync } from "../../modules/repositories/git-exec.mjs";
import { createHarnessRuntime } from "../harnesses/harness-runtime.mjs";
import { LOADING, parseMarkdownFrontmatter } from "../harnesses/project-inventory.mjs";
import { estimateTokens, classifyStartupLevel, classifyOnDemandLevel } from "./context-cost.mjs";
import { renderMarkdown, withoutMarkdownImages } from "./markdown-render.mjs";
import { renderSkillSourceHtml } from "./config-source-render.mjs";
import { renderConfigFileHtml } from "./config-tree-render.mjs";

const fsp = fs.promises;

export const INVENTORY_LIMITS = Object.freeze({
  maxDepth: 12,
  maxEntriesVisited: 20000,
  maxFiles: 400,
  maxFileBytes: 512 * 1024,
  maxTotalBytes: 16 * 1024 * 1024,
  previewBytes: 256 * 1024,
});

// Filesystem calls in flight at once while checking folders, resolving links, and reading files.
const IO_CONCURRENCY = 8;

// A skill popup lists the files bundled beside SKILL.md and shows their text, within these bounds.
const SKILL_FOLDER_LIMITS = Object.freeze({ maxFiles: 40, maxDepth: 3, maxEntries: 500 });

// Dependency trees, build outputs, and caches: large, generated, and never a source of a repo's own
// agent configuration.
const SKIPPED_DIRECTORIES = new Set([
  ".git", "node_modules", "bower_components", "vendor", "dist", "build", "out", "target", "coverage",
  ".next", ".nuxt", ".svelte-kit", ".turbo", ".cache", ".parcel-cache", ".gradle", ".venv", "venv",
  "__pycache__", ".terraform", "Pods", ".yarn", ".pnpm-store",
]);

const SKIPPED_LOWERCASE = new Set([...SKIPPED_DIRECTORIES].map((name) => name.toLowerCase()));
// Inside a harness's own folder, names like `build` or `vendor` are a skill's or command's name, not
// a build output, so only Git internals are skipped there.
const NATIVE_FOLDERS = new Set([".claude", ".agents", ".codex"]);

// Whether the walk skips folder `name` when its ancestors are `ancestors` (path segments).
// Compared case-insensitively: on a case-insensitive filesystem `Node_Modules` is `node_modules`.
function skippedFolder(name, ancestors) {
  const lower = name.toLowerCase();
  if (ancestors.some((segment) => NATIVE_FOLDERS.has(segment.toLowerCase()))) return lower === ".git";
  return SKIPPED_LOWERCASE.has(lower);
}

// Unreadable folders named in the response; the rest are counted.
const MAX_UNREADABLE_LISTED = 5;
const GIT_TIMEOUT_MS = 5000;
const GIT_BATCH = 200;
const CONVERSION_ATTRIBUTES = ["filter", "text", "eol", "ident", "working-tree-encoding"];
// The .gitattributes flag GitHub uses for committed tool output. A file carrying it is rendered from
// somewhere else, so it is listed apart and never counted as this repo's own startup context.
const GENERATED_ATTRIBUTE = "linguist-generated";

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

// Branch or detached HEAD from the checkout's own HEAD file. A reftable repo keeps a placeholder
// there (`ref: refs/heads/.invalid`), so HEAD is asked of Git's read-only allowlist instead.
export function readHead(checkoutPath, { fsApi = fs, runGitSync = defaultRunGitSync } = {}) {
  const resolved = resolveGitDir(checkoutPath, { fsApi });
  if (!resolved) return { kind: "unknown" };
  let raw = "";
  try {
    raw = fsApi.readFileSync(path.join(resolved.gitDir, "HEAD"), "utf8").trim();
  } catch {
    return { kind: "unknown" };
  }
  if (raw === "ref: refs/heads/.invalid") return readHeadFromGit(checkoutPath, runGitSync);
  const ref = /^ref:\s*refs\/heads\/(.+)$/.exec(raw);
  if (ref) return { kind: "branch", name: ref[1] };
  if (/^[0-9a-f]{40}([0-9a-f]{24})?$/.test(raw)) return { kind: "detached", sha: raw.slice(0, 12) };
  return { kind: "unknown" };
}

function readHeadFromGit(checkoutPath, runGitSync) {
  const branch = runGitSync(checkoutPath, ["symbolic-ref", "--short", "-q", "HEAD"]);
  if (branch.ok && branch.stdout.trim()) return { kind: "branch", name: branch.stdout.trim() };
  const commit = runGitSync(checkoutPath, ["rev-parse", "--verify", "-q", "HEAD"]);
  const sha = commit.ok ? commit.stdout.trim() : "";
  return /^[0-9a-f]{40}([0-9a-f]{24})?$/.test(sha) ? { kind: "detached", sha: sha.slice(0, 12) } : { kind: "unknown" };
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

// --------------------------------------------------------------------------- async helpers

// `fn` over `items` with at most `limit` calls pending, results in input order.
async function mapLimit(items, limit, fn) {
  const results = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next;
      next += 1;
      results[index] = await fn(items[index], index);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

function exists(filePath) {
  return fsp.access(filePath).then(() => true, () => false);
}

// --------------------------------------------------------------------------- bounded walk

// Breadth-first, so a truncated scan still covers the root and the shallow folders where most
// configuration lives. Folders are listed one at a time in path order, so which entries the budget
// reaches never depends on timing. Symlinks are never followed; a symlink that names a native source
// is listed, and read later only if it resolves inside this checkout. A subfolder with its own `.git`
// is another checkout and is skipped whole.
async function walkCheckout(root, providers, limits) {
  const candidates = [];
  const truncated = new Set();
  // Folders the walk could not open: their files may be missing, which is not the same as none.
  const unreadable = [];
  let visited = 0;
  const done = () => ({ candidates, truncated: [...truncated], unreadable });
  const queue = [{ rel: "", depth: 0 }];
  while (queue.length) {
    const { rel, depth } = queue.shift();
    const listing = await readDirectoryBounded(rel ? path.join(root, rel) : root, limits.maxEntriesVisited - visited);
    if (!listing) {
      unreadable.push(rel);
      continue;
    }
    const { dirents, more } = listing;
    dirents.sort((a, b) => a.name.localeCompare(b.name));
    const folders = [];
    for (const dirent of dirents) {
      visited += 1;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isSymbolicLink() || dirent.isFile()) {
        const symlink = dirent.isSymbolicLink();
        for (const found of classifyWith(providers, childRel, { symlink })) {
          if (candidates.length >= limits.maxFiles) {
            truncated.add("files");
            return done();
          }
          candidates.push({ rel: childRel, symlink, ...found });
        }
        continue;
      }
      if (dirent.isDirectory()) {
        if (skippedFolder(dirent.name, rel ? rel.split("/") : [])) continue;
        if (depth + 1 > limits.maxDepth) {
          truncated.add("depth");
          continue;
        }
        folders.push({ rel: childRel, depth: depth + 1 });
      }
    }
    const nested = await mapLimit(folders, IO_CONCURRENCY, (folder) => exists(path.join(root, folder.rel, ".git")));
    folders.forEach((folder, index) => {
      if (!nested[index]) queue.push(folder);
    });
    if (more) {
      truncated.add("entries");
      return done();
    }
  }
  return done();
}

// Up to `budget` entries of a folder, read incrementally so a huge folder is never listed or sorted
// whole: { dirents, more } where `more` says entries were left unread, or null when it cannot be
// opened. Within a folder cut short, which entries are kept follows the filesystem's order.
async function readDirectoryBounded(dirPath, budget) {
  let dir;
  try {
    dir = await fsp.opendir(dirPath, { bufferSize: 64 });
  } catch {
    return null;
  }
  const dirents = [];
  try {
    let dirent;
    while (dirents.length < budget && (dirent = await dir.read()) !== null) dirents.push(dirent);
    return { dirents, more: dirents.length >= budget && (await dir.read()) !== null };
  } catch {
    return null;
  } finally {
    await dir.close().catch(() => {});
  }
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
  return folders.length <= limits.maxDepth && !folders.some((folder, index) => skippedFolder(folder, folders.slice(0, index)));
}

// Checked at read time: every parent of `parts` is a real directory of this checkout, with no
// symlink and no nested `.git`. Returns null when they all are, or the reason one is not.
async function parentProblem(root, parts) {
  let current = root;
  for (const part of parts.slice(0, -1)) {
    current = path.join(current, part);
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch {
      return "The file is no longer there.";
    }
    if (!stat.isDirectory() || stat.isSymbolicLink()) return "The path leaves this checkout.";
    if (await exists(path.join(current, ".git"))) return "The path is inside another checkout.";
  }
  return null;
}

// Reads a regular file inside the checkout, rechecking at read time that every parent is a real
// directory of this checkout (no symlink, no nested `.git`) and the file is not a symlink.
// Returns { ok, buffer, size, complete } or { ok: false, diagnostic }.
export async function readConfinedFile(root, relPath, maxBytes) {
  const parts = cleanSegments(relPath);
  if (!parts) return { ok: false, diagnostic: "Not a path inside this checkout." };
  const problem = await parentProblem(root, parts);
  if (problem) return { ok: false, diagnostic: problem };
  const filePath = path.join(root, ...parts);
  let handle;
  try {
    const stat = await fsp.lstat(filePath);
    if (stat.isSymbolicLink()) return { ok: false, diagnostic: "This is a symbolic link; its target is not read." };
    if (!stat.isFile()) return { ok: false, diagnostic: "Not a regular file." };
    const real = await fsp.realpath(filePath);
    if (!real.startsWith(root + path.sep)) return { ok: false, diagnostic: "The path leaves this checkout." };
    handle = await fsp.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    // The open resolves the path again, so a parent swapped for a symlink since the checks above
    // could open a file outside the checkout. Only the file that was checked is read.
    const opened = await handle.stat();
    if (opened.dev !== stat.dev || opened.ino !== stat.ino) return { ok: false, diagnostic: "The file changed while it was being read." };
    // A parent swapped to a symlink for the lstat and the open, but back for the realpath, would pass
    // the checks above. After the open, the path must still resolve inside the checkout to the very
    // file that was opened. Node has no openat-style resolution, so a swap timed between these calls
    // remains possible; this narrows it to a window after the open.
    const reopened = await fsp.realpath(filePath);
    if (!reopened.startsWith(root + path.sep)) return { ok: false, diagnostic: "The path leaves this checkout." };
    const resolved = await fsp.lstat(reopened);
    if (resolved.dev !== opened.dev || resolved.ino !== opened.ino) return { ok: false, diagnostic: "The file changed while it was being read." };
    const length = Math.min(stat.size, maxBytes);
    const buffer = Buffer.alloc(length);
    let offset = 0;
    while (offset < length) {
      const { bytesRead } = await handle.read(buffer, offset, length - offset, offset);
      if (bytesRead === 0) break;
      offset += bytesRead;
    }
    return { ok: true, buffer: buffer.subarray(0, offset), size: stat.size, complete: stat.size <= maxBytes };
  } catch {
    return { ok: false, diagnostic: "Could not read this file." };
  } finally {
    await handle?.close().catch(() => {});
  }
}

// The file a symlinked entry stands for, when that is something the walk itself could list: inside
// this checkout, under no skipped folder, symlink, or nested checkout. A symlinked skill folder
// stands for its SKILL.md. Returns the target's relative path, or null when the link is not read.
async function inCheckoutTarget(root, relPath, { skillFolder, limits }) {
  const parts = cleanSegments(relPath);
  if (!parts || await parentProblem(root, parts)) return null;
  let real;
  try {
    real = await fsp.realpath(path.join(root, ...parts));
  } catch {
    return null;
  }
  if (!real.startsWith(root + path.sep)) return null;
  let target = path.relative(root, real).split(path.sep).join("/");
  try {
    const stat = await fsp.stat(real);
    if (stat.isDirectory()) {
      if (!skillFolder) return null;
      target = `${target}/SKILL.md`;
    }
  } catch {
    return null;
  }
  return withinWalk(cleanSegments(target), limits) ? target : null;
}

// What an entry's text is read from: its own path, a symlink's in-checkout target, or null.
function readTarget(root, { rel, symlink, match }, limits) {
  if (!symlink) return Promise.resolve(rel);
  if (match.kind === "linked-folder") return Promise.resolve(null);
  const skillFolder = match.kind === "skill" && rel.split("/").at(-1) !== "SKILL.md";
  return inCheckoutTarget(root, rel, { skillFolder, limits });
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

// A partial clone may lack the indexed .gitattributes blob that `check-attr` falls back to when the
// working file is missing. With lazy fetch off, Git then reports "unspecified" and exits 0, so no
// attribute answer from a partial clone can be trusted. Git before 2.44 ignores GIT_NO_LAZY_FETCH
// and would fetch that blob from the remote, so `check-attr` is not run there at all.
function isPartialClone(root) {
  const resolved = resolveGitDir(root);
  if (!resolved) return false;
  try {
    const config = fs.readFileSync(path.join(resolved.commonDir, "config"), "utf8");
    return /^\s*(?:partialclone\s*=|promisor\s*=\s*true\b)/im.test(config);
  } catch {
    return false;
  }
}

// statuses: relPath -> { status: "tracked" | "untracked" | "ignored" | "unavailable", blob?, mode? }.
// converted: relPath -> true when a conversion attribute applies, false when none does; a path whose
// attribute query failed or cannot be trusted is absent, meaning unknown.
// generated: the paths marked linguist-generated; empty when attributes are unknown.
async function classifyGitStatus(root, relPaths, { runGit = defaultRunGit } = {}) {
  const result = new Map(relPaths.map((rel) => [rel, { status: "unavailable" }]));
  const converted = new Map();
  const generated = new Set();
  if (!relPaths.length || !resolveGitDir(root)) return { statuses: result, converted, generated };
  const attributesTrusted = !isPartialClone(root);
  const run = (args) => runGit(root, args, { timeoutMs: GIT_TIMEOUT_MS });
  for (const batch of chunks(relPaths, GIT_BATCH)) {
    const specs = batch.map((rel) => `:(literal)${rel}`);
    const [cached, others, ignored, attrs] = await Promise.all([
      run(["ls-files", "-z", "-s", "--", ...specs]),
      run(["ls-files", "-z", "--others", "--exclude-standard", "--", ...specs]),
      run(["ls-files", "-z", "--others", "--ignored", "--exclude-standard", "--", ...specs]),
      attributesTrusted
        ? run(["check-attr", "-z", ...CONVERSION_ATTRIBUTES, GENERATED_ATTRIBUTE, "--", ...batch])
        : { ok: false },
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
    if (attrs.ok && attributesTrusted) {
      for (const rel of batch) converted.set(rel, false);
      const fields = String(attrs.stdout).split("\0");
      for (let index = 0; index + 2 < fields.length; index += 3) {
        const [rel, attribute, value] = fields.slice(index, index + 3);
        if (attribute === GENERATED_ATTRIBUTE) {
          if (value === "set" || value === "true") generated.add(rel);
        } else if (value && value !== "unspecified" && converted.has(rel)) {
          converted.set(rel, true);
        }
      }
    }
  }
  // A failed query leaves its paths "unavailable" rather than guessing a status.
  return { statuses: result, converted, generated };
}

// True or false when the in-process hash comparison is reliable; null when it is not. `converted`
// is null when the conversion attributes are unknown. Unless they are known to be absent, neither
// outcome is conclusive: a clean filter can make different working bytes clean to Git, or make
// bytes equal to the blob differ from what Git would store.
function localModification(git, buffer, complete, converted) {
  if (git.status !== "tracked" || !git.blob || git.mode === "120000" || !buffer || !complete) return null;
  if (converted !== false) return null;
  const algorithm = git.blob.length === 64 ? "sha256" : "sha1";
  const hash = createHash(algorithm).update(`blob ${buffer.length}\0`).update(buffer).digest("hex");
  if (hash === git.blob) return false;
  if (buffer.includes(0x0d)) return null;
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

// What a harness reads of a skill or command before it is invoked: its name and description, as the
// global page's startup estimate measures them.
function discoveryTokens(kind, text, fallbackName) {
  if (kind !== "skill" && kind !== "command") return null;
  const meta = parseMarkdownFrontmatter(text);
  const description = typeof meta.description === "string" ? meta.description : "";
  const discovery = kind === "skill"
    ? [typeof meta.name === "string" && meta.name ? meta.name : fallbackName, description].filter(Boolean).join(": ")
    : description;
  return estimateTokens(discovery).tokens;
}

// Byte budgets for the inventory's reads, decided in listing order before any read starts, so the
// reads can run concurrently and still cut off at the same file a one-at-a-time scan would.
async function planReads(root, targets, limits) {
  const sizes = await mapLimit(targets, IO_CONCURRENCY, async (rel) => {
    try {
      return (await fsp.lstat(path.join(root, rel))).size;
    } catch {
      return 0;
    }
  });
  let remaining = limits.maxTotalBytes;
  return targets.map((rel, index) => {
    if (remaining <= 0) return { rel, skip: true };
    const allowance = Math.min(limits.maxFileBytes, remaining);
    remaining -= Math.min(sizes[index], allowance);
    return { rel, allowance, budgetLimited: allowance < limits.maxFileBytes };
  });
}

async function readPlanned(root, plan, truncated) {
  if (plan.skip) {
    truncated.push("bytes");
    return { ok: false, diagnostic: "Not read: the scan reached its size budget." };
  }
  const read = await readConfinedFile(root, plan.rel, plan.allowance);
  // Cut short by the scan's budget rather than the per-file limit: the scan is partial.
  if (read.ok && !read.complete && plan.budgetLimited && read.size > plan.allowance) {
    truncated.push("bytes");
    return { ...read, budgetCut: true };
  }
  return read;
}

const STARTUP_BASIS_KEYS = {
  instructions: "instructions",
  "skill-discovery": "skillDiscovery",
  "command-discovery": "commandDiscovery",
};

// Per supported harness, what a session started at the repo root reads from this repo before its
// first message. Generated files are never counted: they are rendered from somewhere else.
function startupTotals(providers, entries) {
  return providers.filter((provider) => provider.inventory && !provider.error).map((provider) => {
    const own = entries.filter((entry) => entry.harness === provider.id && !entry.generated);
    let picked;
    try {
      picked = provider.inventory.startupEntries
        ? provider.inventory.startupEntries(own)
        : own.filter((entry) => entry.area === "instructions" && entry.loading === LOADING.rootLevel)
          .map((entry) => ({ entry, basis: "instructions" }));
    } catch {
      picked = [];
    }
    const breakdown = { instructions: 0, skillDiscovery: 0, commandDiscovery: 0 };
    const files = [];
    let unmeasured = 0;
    for (const { entry, basis } of picked) {
      const key = STARTUP_BASIS_KEYS[basis];
      const tokens = basis === "instructions" ? entry.tokens : entry.discoveryTokens;
      if (!key || tokens == null) {
        unmeasured += 1;
        continue;
      }
      breakdown[key] += tokens;
      if (basis === "instructions") files.push(entry.path);
    }
    const tokens = breakdown.instructions + breakdown.skillDiscovery + breakdown.commandDiscovery;
    return {
      harness: provider.id,
      displayName: provider.displayName,
      tokens,
      breakdown,
      files,
      ...(unmeasured ? { unmeasured } : {}),
    };
  });
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
  const { candidates, truncated, unreadable } = await walkCheckout(root, providers, limits);
  const relPaths = [...new Set(candidates.map((candidate) => candidate.rel))];
  const [{ statuses, converted, generated }, targets] = await Promise.all([
    classifyGitStatus(root, relPaths, { runGit }),
    mapLimit(candidates, IO_CONCURRENCY, (candidate) => readTarget(root, candidate, limits)),
  ]);

  // Each file is read once, however many harnesses list it or link to it.
  const plans = await planReads(root, [...new Set(targets.filter(Boolean))], limits);
  const results = await mapLimit(plans, IO_CONCURRENCY, (plan) => readPlanned(root, plan, truncated));
  const reads = new Map(plans.map((plan, index) => [plan.rel, results[index]]));

  const entries = candidates.map(({ rel, symlink, provider, match }, index) => {
    const git = statuses.get(rel) || { status: "unavailable" };
    const target = targets[index];
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
      ...(generated.has(rel) ? { generated: true } : {}),
      symlink,
      ...(symlink && target ? { linkTarget: target } : {}),
      git: { status: git.status },
      tokens: null,
      size: null,
    };
    if (!target) return entry;
    const read = reads.get(target);
    if (!read.ok) return { ...entry, diagnostic: read.diagnostic };
    entry.size = read.size;
    const modified = symlink ? null : localModification(git, read.buffer, read.complete, converted.get(rel) ?? null);
    if (modified !== null) entry.git.modified = modified;
    if (!read.complete) {
      return { ...entry, diagnostic: read.budgetCut
        ? "Not fully read: the scan reached its size budget."
        : "Larger than the inspector reads; metadata is unavailable." };
    }
    const text = textOf(read.buffer);
    if (match.format === "text") entry.tokens = estimateTokens(text).tokens;
    const described = describeWith(provider, match, text);
    const loading = described.loading ?? entry.loading;
    const discovery = discoveryTokens(match.kind, text, entry.name);
    return {
      ...entry,
      name: described.name ?? entry.name,
      description: described.description ?? null,
      loading,
      // Lets the page show one row for copies of the same file under several harnesses.
      contentHash: createHash("sha1").update(read.buffer).digest("hex").slice(0, 16),
      ...(entry.tokens !== null ? { tokenLevel: tokenLevel(entry.tokens, loading) } : {}),
      ...(discovery !== null ? { discoveryTokens: discovery } : {}),
      ...(described.sections?.length ? { sections: described.sections.map(String) } : {}),
      ...(described.diagnostic ? { diagnostic: String(described.diagnostic) } : {}),
    };
  });

  return {
    ...base,
    status: "ok",
    // The checkout path stays on the server: the page never shows it, and absolute paths reveal the
    // machine layout to anything that can call the route.
    checkout: { head: checkout.head },
    truncated: [...new Set(truncated)],
    ...(unreadable.length ? { unreadableFolders: unreadable.slice(0, MAX_UNREADABLE_LISTED), unreadableCount: unreadable.length } : {}),
    providers: providerSummary(),
    startup: startupTotals(providers, entries),
    entries,
  };
}

// --------------------------------------------------------------------------- previews

function splitFrontmatter(text) {
  const normalized = String(text ?? "").replace(/\r\n/g, "\n");
  const match = /^---\n[\s\S]*?\n---\n?([\s\S]*)$/.exec(normalized);
  return { meta: parseMarkdownFrontmatter(normalized), body: match ? match[1] : normalized };
}

// Files bundled beside a skill's SKILL.md, as paths relative to its folder: breadth-first, bounded,
// never through a symlink or into a nested checkout or skipped folder.
async function listSkillFolder(root, folderRel) {
  const files = [];
  let visited = 0;
  const queue = [{ rel: "", depth: 0 }];
  while (queue.length && files.length < SKILL_FOLDER_LIMITS.maxFiles) {
    const { rel, depth } = queue.shift();
    const listing = await readDirectoryBounded(path.join(root, folderRel, rel), SKILL_FOLDER_LIMITS.maxEntries - visited);
    if (!listing) continue;
    const dirents = listing.dirents.sort((a, b) => a.name.localeCompare(b.name));
    for (const dirent of dirents) {
      visited += 1;
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      if (dirent.isFile()) {
        if (childRel !== "SKILL.md" && dirent.name !== ".DS_Store") files.push(childRel);
      } else if (dirent.isDirectory() && depth + 1 <= SKILL_FOLDER_LIMITS.maxDepth && !skippedFolder(dirent.name, [])
        && !(await exists(path.join(root, folderRel, childRel, ".git")))) {
        queue.push({ rel: childRel, depth: depth + 1 });
      }
    }
  }
  return files.slice(0, SKILL_FOLDER_LIMITS.maxFiles);
}

// The same popup body the global page shows for a skill: when it loads, its body, and its bundled
// files. Bundled text shares one byte budget; binary files are listed but not shown.
async function skillSourceHtml(root, skillFileRel, text, title, limits) {
  const { meta, body } = splitFrontmatter(text);
  const folder = skillFileRel.split("/").slice(0, -1).join("/");
  const contextFiles = await listSkillFolder(root, folder);
  const references = [];
  let budget = limits.maxFileBytes;
  for (const file of contextFiles) {
    if (budget <= 0) break;
    const read = await readConfinedFile(root, `${folder}/${file}`, Math.min(limits.previewBytes, budget));
    if (!read.ok || read.buffer.includes(0)) continue;
    budget -= read.buffer.length;
    references.push({ file, content: textOf(read.buffer) + (read.complete ? "" : "\n\n… Preview truncated.") });
  }
  return withoutMarkdownImages(renderSkillSourceHtml({ title, meta, body, contextFiles, references, inventory: null }));
}

// One inventory entry's preview: Markdown rendered without images for instructions, agents, and
// commands; the global page's skill view for skills; a readable list of keys and safe values for
// structured configuration. The entry id is rechecked against the provider and the disk at read
// time, so a request can only name a file the inventory would list.
export async function loadRepositoryAgentConfigSource({
  registry, repositoryId, id, runtime = createHarnessRuntime(), limits = INVENTORY_LIMITS, runGit,
} = {}) {
  const separator = typeof id === "string" ? id.indexOf(":") : -1;
  if (separator < 1) return { ok: false, status: 400, error: "expected an inventory entry id" };
  const harness = id.slice(0, separator);
  const rel = id.slice(separator + 1);
  const checkout = selectPrimaryCheckout(registry, repositoryId);
  if (!checkout.ok) return { ok: false, status: 409, error: checkout.message, reason: checkout.reason };
  const root = checkout.path;
  const provider = inventoryProviders(runtime).find((candidate) => candidate.id === harness && candidate.inventory);
  const parts = cleanSegments(rel);
  if (!provider || !withinWalk(parts, limits)) return { ok: false, status: 404, error: "Not an inventory entry." };
  let symlink = false;
  try {
    symlink = (await fsp.lstat(path.join(root, ...parts))).isSymbolicLink();
  } catch {
    symlink = false;
  }
  const [found] = classifyWith([provider], rel, { symlink });
  if (!found || found.match.kind === "linked-folder") return { ok: false, status: 404, error: "Not an inventory entry." };
  const match = found.match;
  const target = await readTarget(root, { rel, symlink, match }, limits);
  if (!target) return { ok: false, status: 404, error: "This symbolic link points outside this checkout; its target is not read." };
  const read = await readConfinedFile(root, target, Math.max(limits.previewBytes, limits.maxFileBytes));
  if (!read.ok) return { ok: false, status: 404, error: read.diagnostic };
  const { statuses, converted } = await classifyGitStatus(root, [rel], { runGit });
  const gitStatus = statuses.get(rel) || { status: "unavailable" };
  const git = { status: gitStatus.status };
  const modified = symlink ? null : localModification(gitStatus, read.buffer, read.complete, converted.get(rel) ?? null);
  if (modified !== null) git.modified = modified;
  const text = textOf(read.buffer);
  const described = read.complete ? describeWith(provider, match, text) : {};
  const title = described.name || match.name || rel.split("/").at(-1);
  const response = {
    ok: true,
    id,
    harness,
    harnessName: provider.displayName,
    path: rel,
    ...(symlink ? { linkTarget: target } : {}),
    title,
    label: match.label,
    area: match.area,
    kind: match.kind,
    format: match.format,
    git,
    size: read.size,
  };
  if (match.format !== "text") {
    const diagnostic = read.complete ? described.diagnostic : "Larger than the inspector reads; metadata is unavailable.";
    // A readable list of keys with only safe values; the same view the global page's config popups use.
    const html = read.complete ? renderConfigFileHtml(text, { format: match.format }) : null;
    return { ...response, sections: described.sections || [], ...(html ? { html } : {}), ...(diagnostic ? { diagnostic } : {}) };
  }
  // The preview limit is in bytes; a character cut at the boundary decodes as U+FFFD.
  const shownBytes = read.buffer.subarray(0, limits.previewBytes);
  const truncated = !read.complete || shownBytes.length < read.buffer.length;
  const content = textOf(shownBytes);
  const shown = truncated ? `${content}\n\n… Preview truncated.` : content;
  const discovery = read.complete ? discoveryTokens(match.kind, text, match.name ?? null) : null;
  return {
    ...response,
    content,
    truncated,
    tokens: read.complete ? estimateTokens(text).tokens : null,
    ...(discovery !== null ? { discoveryTokens: discovery } : {}),
    loading: described.loading ?? match.loading,
    html: match.kind === "skill"
      ? await skillSourceHtml(root, target, shown, title, limits)
      : withoutMarkdownImages(renderMarkdown(shown)),
  };
}
