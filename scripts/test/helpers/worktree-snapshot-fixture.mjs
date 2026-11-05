import { randomUUID } from "node:crypto";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "../../../modules/repositories/git-exec.mjs";
import { inventoryWorktree, readSnapshot, writeTree, required, checksum, SNAPSHOT_PREFIX } from "../../../modules/repositories/worktree-snapshot.mjs";

const ZERO = "0".repeat(40);

// Synthetic legacy archives exercise migration and restoration without shipping capture behavior.
export async function createWorktreeSnapshot(cwd, { expectedFingerprint = null, pruneDisposable = true } = {}) {
  try {
    const inventory = await inventoryWorktree(cwd, { pruneDisposable });
    if (expectedFingerprint && expectedFingerprint !== inventory.fingerprint) throw new Error("worktree changed before snapshot");
    const git = (args, options = {}) => runGitProcess(cwd, args, { timeoutMs: 10000, ...options });
    const existing = required(await git(["for-each-ref", "--format=%(refname)", SNAPSHOT_PREFIX], { maxBuffer: GIT_MAX_BINARY_BUFFER }));
    for (const ref of existing.trim().split("\n").filter(Boolean)) {
      let manifest;
      try {
        manifest = JSON.parse(required(await git(["show", `${ref}:manifest.json`], { maxBuffer: GIT_MAX_BINARY_BUFFER })));
        if (manifest?.fingerprint !== inventory.fingerprint) continue;
        ({ manifest } = await readSnapshot(cwd, ref));
      } catch { continue; }
      return { ok: true, id: manifest.id, ref, fingerprint: inventory.fingerprint, reused: true, restoreCommand: `roborepo git worktrees restore ${manifest.id} --destination <new-path> --apply` };
    }
    const index = [];
    for (const entry of inventory.index) {
      const bytes = required(await git(["cat-file", "blob", entry.oid], { binary: true, maxBuffer: GIT_MAX_BINARY_BUFFER }));
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
    const fresh = await inventoryWorktree(cwd, { pruneDisposable });
    if (fresh.fingerprint !== inventory.fingerprint) throw new Error("worktree changed during snapshot");
    const format = required(await git(["rev-parse", "--show-object-format"])).trim();
    const ref = `${SNAPSHOT_PREFIX}${id}`;
    required(await git(["update-ref", ref, commit, format === "sha256" ? "0".repeat(64) : ZERO]));
    return { ok: true, id, ref, commit, fingerprint: inventory.fingerprint, restoreCommand: `roborepo git worktrees restore ${id} --destination <new-path> --apply` };
  } catch (error) { return { ok: false, reason: error.message }; }
}
