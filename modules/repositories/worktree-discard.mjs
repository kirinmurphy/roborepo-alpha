import fs from "node:fs";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { discoverWorktreeArtifacts } from "./worktree-artifacts.mjs";
import { runGitProcess, GIT_MAX_BINARY_BUFFER } from "./git-exec.mjs";
import { linkedWorktrees } from "./worktree-inventory.mjs";
import { checkWorktreeRemoval } from "./worktree-guards.mjs";
import { inspectBranchLanding, defaultLandingBase } from "./worktree-landed.mjs";
import { withCleanupLock, removeWorktree } from "./worktree-removal.mjs";
import { findRetentionStore, measureFileSet } from "../retention/index.mjs";

const DAY = 86400000;
const RECEIPT_DETAIL_LIMIT = 2 * 1024 * 1024;
const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

// Raw bytes, index identities and flags are independent of filters and worktree conversion rules.
// No status/diff command is used: those commands may run a configured clean filter.
export async function inventoryDiscard(cwd, { timeoutMs = 120000, runGit = runGitProcess } = {}) {
  const deadline = Date.now() + timeoutMs;
  const checkTime = (file = cwd) => { if (Date.now() >= deadline) throw new Error(`inventory time limit exceeded: ${file}`); };
  const git = async (args) => {
    checkTime();
    const result = await runGit(cwd, args, { timeoutMs: Math.max(1, deadline - Date.now()), maxBuffer: GIT_MAX_BINARY_BUFFER });
    if (!result.ok) throw new Error(`inventory unavailable: ${args[0]}: ${result.error}`);
    return result.stdout;
  };
  const tip = (await git(["rev-parse", "HEAD"])).trim();
  const indexRaw = await git(["ls-files", "--stage", "-z"]);
  const flags = await git(["ls-files", "-v", "-z"]);
  const debug = await git(["ls-files", "--debug", "-z"]);
  const index = indexRaw.split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) ([a-f0-9]+) (\d)\t([\s\S]+)$/.exec(line);
    if (!match) throw new Error("unreadable index entry");
    if (match[1] === "160000") throw new Error(`submodule: ${match[4]}`);
    return { path: match[4], mode: match[1], oid: match[2], stage: match[3] };
  });
  const baseline = (await git(["ls-tree", "-r", "-z", tip])).split("\0").filter(Boolean).map((line) => {
    const match = /^(\d+) (blob|commit) ([a-f0-9]+)\t([\s\S]+)$/.exec(line);
    if (!match || match[2] === "commit") throw new Error(`unsupported committed entry: ${line}`);
    return { path: match[4], mode: match[1], oid: match[3] };
  });
  const tracked = new Set([...index, ...baseline].map((entry) => entry.path));
  const format = (await git(["rev-parse", "--show-object-format"])).trim();
  if (!["sha1", "sha256"].includes(format)) throw new Error("unsupported object format");
  const artifacts = await discoverWorktreeArtifacts(cwd, { deadline, git: async (args, options) => runGit(cwd, args, { ...options, timeoutMs: Math.max(1, deadline - Date.now()) }) });
  const disposables = new Set(artifacts.disposable.map((entry) => entry.path));
  const ignored = artifacts.ignored.map((file) => file.replace(/\/$/, ""));
  const entries = [];
  const walk = async (relative) => {
    checkTime(relative);
    if (relative === ".git") return;
    if (relative.split("/").some((part) => part.toLowerCase() === ".git")) throw new Error(`nested repo: ${relative}`);
    const absolute = path.join(cwd, relative);
    const stat = fs.lstatSync(absolute);
    if (disposables.has(relative)) { entries.push({ path: relative, type: "disposable", device: stat.dev, inode: stat.ino }); return; }
    const group = tracked.has(relative) ? "tracked" : ignored.some((file) => relative === file || relative.startsWith(`${file}/`)) ? "ignored" : "untracked";
    if (stat.isDirectory()) {
      const children = fs.readdirSync(absolute).sort();
      if (children.some((name) => name.toLowerCase() === ".git")) throw new Error(`nested repo: ${relative}`);
      if (!children.length) entries.push({ path: relative, group, type: "directory", mode: stat.mode & 0o7777 });
      for (const child of children) await walk(`${relative}/${child}`);
      return;
    }
    const type = stat.isFile() ? "file" : stat.isSymbolicLink() ? "symlink" : stat.isFIFO() ? "fifo" : stat.isSocket() ? "socket" : stat.isCharacterDevice() ? "character-device" : "block-device";
    const entry = { path: relative, group, type, mode: stat.mode & 0o7777, bytes: stat.size };
    if (type === "file" || type === "symlink") {
      const hash = createHash("sha256");
      const blob = createHash(format).update(`blob ${type === "file" ? stat.size : fs.readlinkSync(absolute, { encoding: "buffer" }).length}\0`);
      if (type === "symlink") {
        const bytes = fs.readlinkSync(absolute, { encoding: "buffer" }); hash.update(bytes); blob.update(bytes);
      } else {
        const stream = fs.createReadStream(absolute, { flags: fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0) });
        const timer = setTimeout(() => stream.destroy(new Error(`inventory time limit exceeded: ${relative}`)), Math.max(1, deadline - Date.now()));
        try { for await (const chunk of stream) { checkTime(relative); hash.update(chunk); blob.update(chunk); } } finally { clearTimeout(timer); stream.destroy(); }
      }
      const after = fs.lstatSync(absolute);
      if (after.ino !== stat.ino || after.dev !== stat.dev || after.size !== stat.size || after.mtimeMs !== stat.mtimeMs || after.ctimeMs !== stat.ctimeMs) throw new Error(`entry changed during inventory: ${relative}`);
      entry.digest = hash.digest("hex"); entry.oid = blob.digest("hex");
    }
    entries.push(entry);
  };
  for (const name of fs.readdirSync(cwd).sort()) await walk(name);
  checkTime();
  const groups = { tracked: [], untracked: [], ignored: [], disposable: artifacts.disposable };
  const indexByPath = new Map(index.map((entry) => [entry.path, entry]));
  const baseByPath = new Map(baseline.map((entry) => [entry.path, entry]));
  const files = new Map(entries.map((entry) => [entry.path, entry]));
  for (const file of [...tracked].sort()) {
    const before = baseByPath.get(file), staged = indexByPath.get(file), local = files.get(file);
    const mode = local?.type === "symlink" ? "120000" : local?.mode & 0o111 ? "100755" : "100644";
    if (before?.oid !== staged?.oid || before?.mode !== staged?.mode || staged?.stage !== "0" || local?.oid !== staged?.oid || mode !== staged?.mode) groups.tracked.push({ path: file, change: !local ? "deleted" : !before ? "added" : "modified" });
  }
  for (const entry of entries) if (entry.group && entry.group !== "tracked") groups[entry.group].push({ path: entry.path, type: entry.type, bytes: entry.bytes || 0 });
  const identities = Object.fromEntries(["tracked", "untracked", "ignored", "disposable"].map((group) => [group, Object.create(null)]));
  for (const entry of entries) identities[entry.group || "disposable"][entry.path] = digest(entry);
  identities.index = digest({ indexRaw, flags, debug });
  return { tip, groups, identities, digest: digest({ tip, identities }) };
}

export async function previewWorktreeDiscard(options) {
  const { mainPath, stateRoot } = options;
  const locked = await withCleanupLock(stateRoot, async () => {
    try {
      const assessment = await assessDiscard(options);
      if (!assessment.eligible) return assessment;
      const now = Date.now();
      const record = { id: randomUUID(), state: "previewed", target: assessment.target, scope: assessment.scope, createdAt: new Date(now).toISOString(), expiresAt: new Date(now + DAY).toISOString(), digest: assessment.inventory.digest, identities: compactIdentities(assessment.inventory.identities) };
      saveTransaction(stateRoot, record);
      const { inventory, ...preview } = assessment;
      return { ...preview, receipt: record.id, expiresAt: record.expiresAt };
    } catch (error) { return kept(error.message); }
  }, { repositoryPath: mainPath });
  return locked.locked ? kept("cleanup already running") : locked.result;
}

export async function applyWorktreeDiscard(options) {
  const { mainPath, stateRoot, receipt, stop = async () => ({ ok: true }), activePlans = () => new Set() } = options;
  const locked = await withCleanupLock(stateRoot, async () => {
    let record;
    try { record = readTransaction(stateRoot, receipt); } catch { return kept("valid receipt required; request a new preview"); }
    if (options.requiredScope && record.scope !== options.requiredScope) return kept("receipt scope does not match the requested operation");
    if (record.state !== "previewed" || !Number.isFinite(Date.parse(record.expiresAt)) || Date.parse(record.expiresAt) <= Date.now()) return kept("receipt consumed or expired; request a new preview");
    if (record.target.repositoryId !== options.repositoryId || record.target.name !== options.worktree.name || record.target.path !== options.worktree.path) return kept("receipt does not match repo and worktree");
    const assess = () => assessDiscard({ ...options, scope: record.scope, base: record.target.baseRef, activePlans });
    try {
      let fresh = await assess();
      let difference = compareAssessment(record, fresh);
      if (difference) return difference;
      const stopped = await stop(record.target.path);
      if (!stopped.ok) return kept("selected checkout servers did not stop");
      fresh = await assess();
      difference = compareAssessment(record, fresh);
      if (difference) return difference;
      // The lock serializes cleanup commands, not arbitrary editor writes after this last check.
      const result = await removeWorktree(mainPath, options.worktree, { kind: "confirmed", stateRoot, tip: record.target.tip, transaction: record, authority: { scope: record.scope, digest: record.digest } });
      return removalResult(result, options.worktree);
    } catch (error) { return kept(error.message); }
  }, { repositoryPath: mainPath });
  return locked.locked ? kept("cleanup already running") : locked.result;
}

async function assessDiscard({ mainPath, repositoryId, worktree, scope = "all", base = null, currentPath = mainPath, activePlans = () => new Set(), servers = [], runGit = runGitProcess }) {
  if (!["all", "leftovers"].includes(scope)) throw new Error("scope must be leftovers or all");
  const fresh = linkedWorktrees(path.join(mainPath, ".git")).find((item) => item.name === worktree.name);
  if (!fresh || fresh.path !== worktree.path || fresh.branch !== worktree.branch || fresh.detachedCommit !== worktree.detachedCommit) throw new Error("worktree identity changed");
  const guard = await checkWorktreeRemoval({ worktree: fresh, kind: "confirmed", consent: true, mainPath, currentPath, activePlan: activePlans().has(fresh.name) });
  if (!guard.ok) throw new Error(guard.reason);
  const inventory = await inventoryDiscard(fresh.path, { runGit });
  base ||= await defaultLandingBase((args) => runGit(mainPath, args));
  if (!base) throw new Error("base unavailable");
  const baseState = await runGit(mainPath, ["rev-parse", "--verify", `${base}^{commit}`]);
  if (!baseState.ok) throw new Error("base unavailable");
  const baseCommit = baseState.stdout.trim();
  const landing = fresh.branch ? await inspectBranchLanding(mainPath, fresh.branch, { base, runGit }) : { landed: false };
  if (scope === "leftovers" && !landing.landed) throw new Error("committed work is not proven landed; leftovers consent cannot discard commits");
  const log = await runGit(mainPath, ["log", "--format=%s", `${baseCommit}..${inventory.tip}`], { maxBuffer: GIT_MAX_BINARY_BUFFER, timeoutMs: 10000 });
  if (!log.ok) throw new Error("unmerged commit inventory unavailable");
  const subjects = log.stdout.trimEnd().split("\n").filter(Boolean);
  const stat = fs.lstatSync(fresh.path);
  return { action: "preview", eligible: true, scope, target: { repositoryId, repositoryPath: mainPath, path: fresh.path, name: fresh.name, branch: fresh.branch, tip: inventory.tip, baseRef: base, baseCommit, device: stat.dev, inode: stat.ino }, commits: { landed: landing.landed, unmerged: subjects.length, subjects }, groups: inventory.groups, servers, warnings: guard.warning ? [guard.warning] : [], blockers: [], inventory };
}

function compareAssessment(record, fresh) {
  if (!fresh.eligible || digest(record.target) !== digest(fresh.target) || record.digest !== fresh.inventory.digest) {
    return { ...kept("state changed after preview; review a new preview"), differences: differences(record.identities, fresh.inventory?.identities) };
  }
  return null;
}

export function saveTransaction(stateRoot, record, fsApi = fs) {
  const dir = path.join(stateRoot, "worktree-cleanup", "transactions");
  if (!UUID.test(record.id)) throw new Error("invalid transaction id");
  fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const file = path.join(dir, `${record.id}.json`);
  const temporary = `${file}.${randomUUID()}.tmp`;
  try { fsApi.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); fsApi.renameSync(temporary, file); }
  finally { fsApi.rmSync(temporary, { force: true }); }
  const store = findRetentionStore(stateRoot, "worktree-cleanup-transactions");
  for (const victim of measureFileSet({ dirPath: dir, policy: store.policy, fsApi }).files) fsApi.rmSync(victim, { force: true });
  // Losing a live receipt to retention is fail-closed, including pressure from other repos.
  if (!fsApi.existsSync(file)) throw new Error("transaction pruned; reassessment required");
}

export function readTransaction(stateRoot, id, fsApi = fs) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("invalid receipt");
  return JSON.parse(fsApi.readFileSync(path.join(stateRoot, "worktree-cleanup", "transactions", `${id}.json`), "utf8"));
}
export function deleteTransaction(stateRoot, id, fsApi = fs) {
  if (!UUID.test(id)) throw new Error("invalid transaction id");
  fsApi.rmSync(path.join(stateRoot, "worktree-cleanup", "transactions", `${id}.json`), { force: true });
}
export function removalResult(result, worktree) {
  return { action: result.ok ? "removed" : result.kept ? "kept" : "failed", eligible: !result.kept, reason: result.reason || null, path: worktree.path, name: worktree.name, branch: worktree.branch, outcomes: result.outcomes || [], ...(result.entry?.branchDeleted === false ? { retryCommand: `roborepo git worktrees cleanup --remove ${worktree.name} --confirm --apply` } : {}) };
}
function compactIdentities(identities) {
  return Buffer.byteLength(JSON.stringify(identities)) <= RECEIPT_DETAIL_LIMIT ? identities : Object.fromEntries(Object.entries(identities).map(([group, values]) => [group, typeof values === "string" ? values : digest(values)]));
}
function differences(before, after = {}) {
  const result = { added: [], removed: [], changed: [], groups: [] };
  for (const group of Object.keys(before)) {
    if (typeof before[group] === "string") { if (before[group] !== (typeof after[group] === "string" ? after[group] : digest(after[group]))) result.groups.push(group); continue; }
    for (const file of Object.keys(before[group])) {
      if (!Object.hasOwn(after[group] || {}, file)) result.removed.push(file);
      else if (before[group][file] !== after[group][file]) result.changed.push(file);
    }
    for (const file of Object.keys(after[group] || {})) if (!Object.hasOwn(before[group], file)) result.added.push(file);
  }
  return result;
}
function digest(value) { return createHash("sha256").update(JSON.stringify(value)).digest("hex"); }
function kept(reason) { return { action: "kept", eligible: false, reason, blockers: [reason] }; }
