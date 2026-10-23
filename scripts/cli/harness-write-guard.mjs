import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { STATE_ROOT, isMainModule } from "./roots.mjs";

// A state root in a temporary directory paired with a real HOME is an isolated scratch run (an
// agent sandbox or a dev fixture that set ROBOREPO_STATE_DIR but not HOME). Letting it write the
// user's harness files would mix scratch state into real config, and any path it embeds (a package
// runtime script, for example) disappears when the temporary directory is cleaned up.

function resolvedOrSelf(target) {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

function isInside(child, parent) {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function inTempDir(target) {
  const roots = [os.tmpdir(), "/tmp", "/private/tmp", "/var/folders", "/private/var/folders"];
  const candidates = [path.resolve(target), resolvedOrSelf(target)];
  return roots.some((root) =>
    [path.resolve(root), resolvedOrSelf(root)].some((r) => candidates.some((c) => isInside(c, r))),
  );
}

// Why a write to targetPath (or to harness config generally, when targetPath is omitted) must be
// refused, or null when it is allowed.
export function harnessWriteBlockReason(targetPath = null) {
  const home = os.homedir();
  if (!inTempDir(STATE_ROOT) || inTempDir(home)) return null;
  if (targetPath && !isInside(resolvedOrSelf(targetPath), resolvedOrSelf(home))) return null;
  return `refusing to write ${targetPath ?? "harness config"}: roborepo state is in a temporary directory `
    + `(${STATE_ROOT}) but HOME is ${home}. Point HOME at an isolated directory as well, or unset `
    + "ROBOREPO_STATE_DIR / ROBOREPO_STATE_ROOT.";
}

export function assertHarnessWriteAllowed(targetPath = null) {
  const reason = harnessWriteBlockReason(targetPath);
  if (reason) throw new Error(reason);
}

// The bash installer runs this before its first write: exit 1 with the reason when blocked.
if (isMainModule(import.meta.url)) {
  const reason = harnessWriteBlockReason();
  if (reason) {
    console.error(reason);
    process.exit(1);
  }
}
