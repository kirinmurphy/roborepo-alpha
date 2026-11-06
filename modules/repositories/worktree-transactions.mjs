import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { findRetentionStore, measureFileSet } from "../retention/index.mjs";
import { withCleanupStoreLock } from "./worktree-cleanup-lock.mjs";

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;

export async function saveTransaction(stateRoot, record, fsApi = fs, { requirePreview = false } = {}) {
  const dir = path.join(stateRoot, "worktree-cleanup", "transactions");
  if (!UUID.test(record.id)) throw new Error("invalid transaction id");
  return withCleanupStoreLock(stateRoot, () => {
    fsApi.mkdirSync(dir, { recursive: true, mode: 0o700 });
    const file = path.join(dir, `${record.id}.json`);
    if (requirePreview) {
      const current = readTransaction(stateRoot, record.id, fsApi);
      if (!isDeepStrictEqual(current, { ...record, state: "previewed" }) || Date.parse(current.expiresAt) <= Date.now()) {
        throw new Error("preview expired or changed; request a new preview");
      }
    }
    const temporary = `${file}.${randomUUID()}.tmp`;
    try { fsApi.writeFileSync(temporary, JSON.stringify(record), { mode: 0o600, flag: "wx" }); fsApi.renameSync(temporary, file); }
    finally { fsApi.rmSync(temporary, { force: true }); }
    const store = findRetentionStore(stateRoot, "worktree-cleanup-transactions");
    for (const victim of measureFileSet({ dirPath: dir, policy: store.policy, fsApi }).files) fsApi.rmSync(victim, { force: true });
    // Losing a live receipt to retention is fail-closed, including pressure from other repos.
    if (!fsApi.existsSync(file)) throw new Error("transaction pruned; reassessment required");
  }, fsApi);
}

export function readTransaction(stateRoot, id, fsApi = fs) {
  if (typeof id !== "string" || !UUID.test(id)) throw new Error("invalid receipt");
  return JSON.parse(fsApi.readFileSync(path.join(stateRoot, "worktree-cleanup", "transactions", `${id}.json`), "utf8"));
}
export async function deleteTransaction(stateRoot, id, fsApi = fs) {
  if (!UUID.test(id)) throw new Error("invalid transaction id");
  await withCleanupStoreLock(stateRoot, () => {
    fsApi.rmSync(path.join(stateRoot, "worktree-cleanup", "transactions", `${id}.json`), { force: true });
  }, fsApi);
}
