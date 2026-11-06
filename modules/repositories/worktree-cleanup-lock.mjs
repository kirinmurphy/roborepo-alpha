import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

export async function withCleanupLock(stateRoot, action, { fsApi = fs, repositoryPath = null } = {}) {
  const dir = path.join(stateRoot, "worktree-cleanup");
  fsApi.mkdirSync(dir, { recursive: true });
  const repositoryKey = repositoryPath ? createHash("sha256").update(repositoryPath).digest("hex").slice(0, 16) : "global";
  const file = path.join(dir, `${repositoryKey}.lock`);
  let handle = openLock(file, fsApi);
  // A cleanup killed by a signal or a reboot never reaches `finally`, and its lock would otherwise
  // block every later run. Take over only when the recorded process is gone.
  if (handle == null && staleLock(file, fsApi)) {
    fsApi.rmSync(file, { force: true });
    handle = openLock(file, fsApi);
  }
  if (handle == null) return { locked: true, result: null };
  try {
    fsApi.writeSync(handle, `${process.pid}\n`);
    return { locked: false, result: await action() };
  } finally {
    fsApi.closeSync(handle);
    fsApi.rmSync(file, { force: true });
  }
}

// Removal logs, transaction files and maintenance share one state root across repositories.
export async function withCleanupStoreLock(stateRoot, action, fsApi = fs) {
  const deadline = Date.now() + 5000;
  while (true) {
    const locked = await withCleanupLock(stateRoot, action, { fsApi, repositoryPath: "removal-log" });
    if (!locked.locked) return locked.result;
    if (Date.now() >= deadline) throw new Error("worktree cleanup store lock wait expired");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

function openLock(file, fsApi) {
  try {
    return fsApi.openSync(file, "wx");
  } catch (err) {
    if (err?.code === "EEXIST") return null;
    throw err;
  }
}

// An empty lock may belong to a run that has opened it but not yet written its pid, so only a
// recorded pid with no live process counts as stale.
function staleLock(file, fsApi) {
  let pid;
  try { pid = Number.parseInt(fsApi.readFileSync(file, "utf8"), 10); } catch { return false; }
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (err) {
    return err?.code === "ESRCH";
  }
}
