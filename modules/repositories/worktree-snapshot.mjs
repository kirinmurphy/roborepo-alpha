import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "./git-exec.mjs";

export const SNAPSHOT_PREFIX = "refs/roborepo/worktree-archives/";
export const DISPOSABLE_IGNORED = ["node_modules", "test-results"];
const MODES = new Set(["100644", "100755", "120000"]);
const ZERO = "0".repeat(40);

// Raw inventories deliberately bypass add/checkout, filters, and the user's index. Preview callers
// use an external object store; capture alone publishes objects in the common repository.
export async function inventoryWorktree(cwd, { git = (args, options) => runGitProcess(cwd, args, options) } = {}) {
  const read = async (args) => required(await git(args));
  const config = await read(["config", "--null", "--list"]);
  for (const record of config.split("\0")) {
    const [key, value] = record.split("\n");
    if (/^merge\..*\.driver$/.test(key) || /^filter\./.test(key)) throw new Error(`unsupported Git driver configuration: ${key}`);
    if (["core.sparsecheckout", "core.splitindex", "core.autocrlf"].includes(key) && !["false", "no", "off", "0", ""].includes(value)) throw new Error(`unsupported Git configuration: ${key}`);
  }
  const shared = (await read(["rev-parse", "--shared-index-path"])).trim();
  if (shared) throw new Error("split index unsupported");
  const tip = (await read(["rev-parse", "HEAD"])).trim();
  const worktree = { name: path.basename((await read(["rev-parse", "--absolute-git-dir"])).trim()), path: fs.realpathSync(cwd) };
  const branch = await git(["symbolic-ref", "--quiet", "HEAD"]);
  const indexRaw = await read(["ls-files", "--stage", "-z"]);
  const flags = await read(["ls-files", "-v", "-z"]);
  for (const record of flags.split("\0").filter(Boolean)) {
    if (record[0] !== "H") throw new Error(`unsupported index flag or unmerged stage: ${record.slice(2)}`);
  }
  const debug = await read(["ls-files", "--debug"]);
  if (/flags: (?!0\s)[0-9a-f]+/i.test(debug)) throw new Error("unsupported index flags (intent-to-add, sparse, or extended flags)");
  const index = indexRaw.split("\0").filter(Boolean).map((record) => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(record);
    if (!match || match[3] !== "0" || !MODES.has(match[1]) || /^0+$/.test(match[2])) throw new Error(`unsupported index entry: ${record}`);
    return { path: match[4], mode: match[1], oid: match[2] };
  });
  const tracked = new Set(index.map((entry) => entry.path));
  const untracked = new Set((await read(["ls-files", "--others", "--exclude-standard", "-z"])).split("\0").filter(Boolean));
  const ignored = new Set((await read(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"])).split("\0").filter(Boolean));
  const entries = [];
  const walk = (relative) => {
    if (relative === ".git") return;
    if (relative.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error(`nested repository or administrative path: ${relative}`);
    const absolute = path.join(cwd, relative);
    const stat = fs.lstatSync(absolute);
    const isTracked = tracked.has(relative);
    const isIgnored = !isTracked && !untracked.has(relative) && [...ignored].some((item) => relative === item.replace(/\/$/, "") || relative.startsWith(item.endsWith("/") ? item : `${item}/`));
    if (isIgnored && DISPOSABLE_IGNORED.some((dir) => relative === dir || relative.startsWith(`${dir}/`))) return;
    if (stat.isDirectory()) {
      if (fs.existsSync(path.join(absolute, ".git"))) throw new Error(`nested repository: ${relative}`);
      const children = fs.readdirSync(absolute).sort();
      if (!children.length) entries.push({ path: relative, mode: "directory", layer: isIgnored ? "ignored" : "untracked" });
      for (const child of children) walk(`${relative}/${child}`);
      return;
    }
    if (!stat.isFile() && !stat.isSymbolicLink()) throw new Error(`unsupported special file: ${relative}`);
    if (stat.isFile() && stat.size > GIT_MAX_BINARY_BUFFER) throw new Error(`file exceeds 64 MiB snapshot limit: ${relative}`);
    const bytes = stat.isSymbolicLink() ? Buffer.from(fs.readlinkSync(absolute)) : fs.readFileSync(absolute);
    entries.push({ path: relative, mode: stat.isSymbolicLink() ? "120000" : stat.mode & 0o111 ? "100755" : "100644", layer: isTracked ? "tracked" : isIgnored ? "ignored" : "untracked", checksum: checksum(bytes), bytes });
  };
  for (const file of fs.readdirSync(cwd).sort()) walk(file);
  validatePaths([...index, ...entries]);
  const paths = [...new Set([...index, ...entries].map((entry) => entry.path))];
  const attributes = await inspectRawAttributes(git, paths);
  const identity = { tip, worktree, branch: branch.ok ? branch.stdout.trim() : null, config, attributes, index, entries: entries.map(({ bytes, ...entry }) => entry) };
  return { ...identity, entries, fingerprint: checksum(Buffer.from(JSON.stringify(identity))) };
}

export async function createWorktreeSnapshot(cwd, { expectedFingerprint = null } = {}) {
  try {
    const inventory = await inventoryWorktree(cwd);
    if (expectedFingerprint && expectedFingerprint !== inventory.fingerprint) throw new Error("worktree changed before snapshot");
    const git = (args, options = {}) => runGitProcess(cwd, args, { timeoutMs: 10000, ...options });
    const existing = required(await git(["for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX]));
    for (const ref of existing.trim().split("\n").filter(Boolean)) {
      const { manifest } = await readSnapshot(cwd, ref);
      if (manifest.fingerprint === inventory.fingerprint) return { ok: true, id: manifest.id, ref, fingerprint: inventory.fingerprint, reused: true, restoreCommand: `roborepo git worktrees restore ${manifest.id} --destination <new-path> --apply` };
    }
    const index = [];
    for (const entry of inventory.index) {
      const bytes = required(await git(["cat-file", "blob", entry.oid], { binary: true }));
      index.push({ ...entry, checksum: checksum(bytes) });
    }
    const payload = [];
    for (const entry of inventory.entries) {
      if (!entry.bytes) { payload.push(entry); continue; }
      const oid = required(await git(["hash-object", "-w", "--stdin"], { input: entry.bytes })).trim();
      const { bytes, ...metadata } = entry;
      payload.push({ ...metadata, oid });
    }
    const id = randomUUID();
    const manifest = { version: 1, id, createdAt: new Date().toISOString(), tip: inventory.tip, worktree: inventory.worktree, branch: inventory.branch, fingerprint: inventory.fingerprint, index, entries: payload };
    const layers = [];
    for (const layer of ["index", "tracked", "untracked", "ignored"]) {
      const entries = layer === "index" ? manifest.index : payload.filter((entry) => entry.layer === layer && entry.mode !== "directory");
      layers.push({ path: layer, mode: "040000", type: "tree", oid: await writeTree(entries, git) });
    }
    const manifestOid = required(await git(["hash-object", "-w", "--stdin"], { input: JSON.stringify(manifest) })).trim();
    const tree = await writeTree([{ path: "manifest.json", mode: "100644", oid: manifestOid }, ...layers], git);
    const commit = required(await git(["-c", "user.name=RoboRepo", "-c", "user.email=archive@roborepo.local", "commit-tree", tree, "-p", inventory.tip], { input: "Recoverable worktree snapshot\n" })).trim();
    await readSnapshot(cwd, commit);
    const fresh = await inventoryWorktree(cwd);
    if (fresh.fingerprint !== inventory.fingerprint) throw new Error("worktree changed during snapshot");
    const format = required(await git(["rev-parse", "--show-object-format"])).trim();
    const ref = `${SNAPSHOT_PREFIX}${id}`;
    required(await git(["update-ref", ref, commit, format === "sha256" ? "0".repeat(64) : ZERO]));
    return { ok: true, id, ref, commit, fingerprint: inventory.fingerprint, restoreCommand: `roborepo git worktrees restore ${id} --destination <new-path> --apply` };
  } catch (error) { return { ok: false, reason: error.message }; }
}

export async function listWorktreeSnapshots(cwd) {
  const refs = required(await runGitProcess(cwd, ["for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX, "refs/roborepo/abandoned/"]));
  const result = [];
  for (const ref of refs.trim().split("\n").filter(Boolean)) {
    if (!ref.startsWith(SNAPSHOT_PREFIX)) { result.push({ ref, kind: "committed-tip", localState: false }); continue; }
    try {
      const { manifest } = await readSnapshot(cwd, ref);
      result.push({ id: manifest.id, ref, kind: "snapshot", localState: true, tip: manifest.tip, worktree: manifest.worktree, branch: manifest.branch?.replace(/^refs\/heads\//, "") || null, createdAt: manifest.createdAt });
    } catch (error) { result.push({ ref, kind: "invalid", reason: error.message }); }
  }
  return result;
}

export async function restoreWorktreeSnapshot(cwd, id, destination, { apply = false } = {}) {
  let started = false;
  try {
    const ref = id.startsWith(SNAPSHOT_PREFIX) ? id : `${SNAPSHOT_PREFIX}${id}`;
    if (!/^refs\/roborepo\/worktree-archives\/[a-f0-9-]{36}$/.test(ref)) throw new Error("invalid snapshot id");
    const { manifest, blobs } = await readSnapshot(cwd, ref);
    const target = path.resolve(destination);
    if (fs.existsSync(target)) throw new Error("restore destination already exists");
    // Resolve parents before creating anything; materialization must never walk a symlink.
    for (let parent = path.dirname(target); ; parent = path.dirname(parent)) {
      try {
        if (fs.lstatSync(parent).isSymbolicLink()) throw new Error("symlink ancestor in restore destination");
      } catch (error) { if (error.code !== "ENOENT") throw error; }
      if (path.dirname(parent) === parent) break;
    }
    const preview = { ok: true, ref, destination: target, tip: manifest.tip, action: "preview" };
    if (!apply) return preview;
    required(await runGitProcess(cwd, ["worktree", "add", "--detach", "--no-checkout", target, manifest.tip], { timeoutMs: 10000 }));
    started = true;
    for (const entry of manifest.entries.filter((entry) => entry.mode !== "120000")) {
      const file = path.join(target, entry.path);
      fs.mkdirSync(entry.mode === "directory" ? file : path.dirname(file), { recursive: true });
      if (entry.mode !== "directory") {
        fs.writeFileSync(file, blobs.get(entry.oid), { flag: "wx", mode: entry.mode === "100755" ? 0o755 : 0o644 });
        fs.chmodSync(file, entry.mode === "100755" ? 0o755 : 0o644);
      }
    }
    for (const entry of manifest.entries.filter((entry) => entry.mode === "120000")) {
      const file = path.join(target, entry.path);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.symlinkSync(blobs.get(entry.oid).toString(), file);
    }
    const git = (args, options) => runGitProcess(target, args, options);
    required(await git(["read-tree", "--empty"]));
    const input = manifest.index.map((entry) => `${entry.mode} ${entry.oid}\t${entry.path}\0`).join("");
    required(await git(["update-index", "-z", "--index-info"], { input }));
    const restored = await inventoryWorktree(target);
    if (JSON.stringify(restored.index) !== JSON.stringify(manifest.index.map(({ checksum, ...entry }) => entry))) throw new Error("restored index verification failed");
    const comparable = (entries) => entries.map(({ bytes, oid, layer, ...entry }) => entry).sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(comparable(restored.entries)) !== JSON.stringify(comparable(manifest.entries))) throw new Error("restored filesystem verification failed");
    return { ...preview, action: "restored" };
  } catch (error) { return { ok: false, reason: error.message, incompleteDestination: started ? path.resolve(destination) : null }; }
}

export async function readSnapshot(cwd, ref) {
  const git = (args, options) => runGitProcess(cwd, args, { timeoutMs: 10000, ...options });
  const manifest = JSON.parse(required(await git(["show", `${ref}:manifest.json`])));
  if (manifest.version !== 1 || !Array.isArray(manifest.index) || !Array.isArray(manifest.entries) || !/^[a-f0-9]{40,64}$/.test(manifest.tip)) throw new Error("invalid snapshot manifest");
  validatePaths([...manifest.index, ...manifest.entries]);
  if (!/^[a-f0-9-]{36}$/.test(manifest.id)) throw new Error("invalid snapshot identity");
  for (const entries of [manifest.index, manifest.entries]) {
    if (new Set(entries.map((entry) => entry.path)).size !== entries.length) throw new Error("duplicate snapshot paths");
    for (const entry of entries) {
      if (entry.mode !== "directory" && !/^[a-f0-9]{64}$/.test(entry.checksum || "")) throw new Error(`missing snapshot checksum: ${entry.path}`);
    }
  }
  if (manifest.entries.some((entry) => !["tracked", "untracked", "ignored"].includes(entry.layer))) throw new Error("invalid snapshot layer");
  const parents = required(await git(["rev-list", "--parents", "-n", "1", ref])).trim().split(" ");
  if (parents.length !== 2 || parents[1] !== manifest.tip) throw new Error("snapshot tip parent mismatch");
  const blobs = new Map();
  for (const entry of [...manifest.index, ...manifest.entries]) {
    if (entry.mode === "directory") continue;
    if (!MODES.has(entry.mode) || !/^[a-f0-9]{40,64}$/.test(entry.oid)) throw new Error(`invalid snapshot entry: ${entry.path}`);
    const bytes = required(await git(["cat-file", "blob", entry.oid], { binary: true }));
    if (entry.checksum && checksum(bytes) !== entry.checksum) throw new Error(`snapshot checksum mismatch: ${entry.path}`);
    blobs.set(entry.oid, bytes);
  }
  for (const layer of ["index", "tracked", "untracked", "ignored"]) {
    const expected = layer === "index" ? manifest.index : manifest.entries.filter((entry) => entry.layer === layer && entry.mode !== "directory");
    const tree = required(await git(["ls-tree", "-r", "-z", `${ref}:${layer}`]));
    const actual = tree.split("\0").filter(Boolean).map((line) => {
      const match = /^(\d+) blob ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
      if (!match) throw new Error("invalid snapshot payload tree");
      return { mode: match[1], oid: match[2], path: match[3] };
    });
    const canonical = (entries) => entries.map(({ mode, oid, path: file }) => ({ mode, oid, path: file })).sort((a, b) => a.path.localeCompare(b.path));
    if (JSON.stringify(canonical(actual)) !== JSON.stringify(canonical(expected))) throw new Error(`snapshot payload mismatch: ${layer}`);
  }
  return { manifest, blobs };
}

export async function writeTree(entries, git) {
  const root = new Map();
  for (const entry of entries) {
    const parts = entry.path.split("/");
    let node = root;
    for (const part of parts.slice(0, -1)) {
      if (!node.has(part)) node.set(part, new Map());
      if (!(node.get(part) instanceof Map)) throw new Error(`tree path collision: ${entry.path}`);
      node = node.get(part);
    }
    if (node.has(parts.at(-1))) throw new Error(`duplicate tree path: ${entry.path}`);
    node.set(parts.at(-1), entry);
  }
  const build = async (node) => {
    const records = [];
    for (const [name, value] of node) {
      const entry = value instanceof Map ? { mode: "040000", type: "tree", oid: await build(value) } : value;
      records.push(`${entry.mode} ${entry.type || "blob"} ${entry.oid}\t${name}\0`);
    }
    return required(await git(["mktree", "-z"], { input: records.join("") })).trim();
  };
  return build(root);
}

export function required(result) {
  if (!result.ok) throw new Error(String(result.stderr || "").trim() || result.error || "Git command failed");
  return result.stdout;
}

export function checksum(bytes) { return createHash("sha256").update(bytes).digest("hex"); }

function validatePaths(entries) {
  const names = new Map();
  const symlinks = new Set(entries.filter((entry) => entry.mode === "120000").map((entry) => entry.path));
  for (const entry of entries) {
    const file = entry.path;
    if (typeof file !== "string" || !file || file.includes("\\") || file.includes("\0") || file.includes(":") || /[<>"|?*\x00-\x1f]/.test(file) || file.includes("\ufffd") || path.posix.isAbsolute(file) || /^[a-z]:/i.test(file)
      || file.split("/").some((part) => !part || part === "." || part === ".." || /[ .]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part) || /^\.git(?:[ .]|$)/i.test(part))) throw new Error(`unsafe snapshot path: ${file}`);
    const normalized = file.normalize("NFC").toLowerCase();
    if (names.has(normalized) && names.get(normalized) !== file) throw new Error(`case/normalization collision: ${file}`);
    names.set(normalized, file);
    let parent = path.posix.dirname(file);
    while (parent !== ".") {
      const key = parent.normalize("NFC").toLowerCase();
      if (names.has(key) && names.get(key) !== parent) throw new Error(`case/normalization collision: ${parent}`);
      names.set(key, parent);
      if ([...symlinks].some((link) => link.normalize("NFC").toLowerCase() === key)) throw new Error(`symlink ancestor: ${file}`);
      parent = path.posix.dirname(parent);
    }
  }
}

export async function inspectRawAttributes(git, paths, source = null) {
  if (!paths.length) return "";
  const temporary = source ? fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-attributes-")) : null;
  try {
    // A temporary index gives check-attr the historical attributes on older Git versions too,
    // without checking files out or changing the user's staged state. Split indexes must stay off
    // so this read cannot create shared-index files in the repository.
    const plumbing = temporary ? { indexFile: path.join(temporary, "index") } : null;
    if (source) required(await git(["-c", "core.splitIndex=false", "-c", "core.sparseCheckout=false", "read-tree", source], { plumbing }));
    const attributes = required(await git(["check-attr", ...(source ? ["--cached"] : []), "-z", "--stdin", "filter", "merge", "working-tree-encoding", "text", "eol"], { input: `${paths.join("\0")}\0`, plumbing }));
    const fields = attributes.split("\0");
    for (let i = 0; i + 2 < fields.length; i += 3) {
      const [file, attr, value] = fields.slice(i, i + 3);
      const allowed = attr === "merge" ? ["unspecified", "unset", "set", "text", "binary", "union"] : ["unspecified", "unset"];
      if (!allowed.includes(value)) throw new Error(`unsupported attribute ${attr}=${value}: ${file}`);
    }
    return attributes;
  } finally { if (temporary) fs.rmSync(temporary, { recursive: true, force: true }); }
}
