import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import os from "node:os";
import { spawnSync } from "node:child_process";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Persistence functions import state-paths.mjs, whose STATE_ROOT is a top-level const resolved from
// ROBOREPO_STATE_DIR at import time (see paths.mjs). Sandboxing that requires setting the env var
// on a freshly spawned node process, not inside this already-running one — same pattern as
// package-lifecycle-check.mjs's spawnSync(cli, ..., { env }).
export function testPersistenceRoundTrip() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-schemas-"));
  try {
    const script = path.join(repoRoot, "scripts/test/telemetry-schemas-persistence-child.mjs");
    const env = { ...process.env, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
    const result = spawnSync(process.execPath, [script], { env, encoding: "utf8" });
    assert.equal(result.status, 0, `persistence child process failed:\n${result.stdout}\n${result.stderr}`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
