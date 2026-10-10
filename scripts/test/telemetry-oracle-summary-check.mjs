import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "oracle-summary-"));
const summaryPath = path.join(root, "summary.md");
try {
  const result = spawnSync(process.execPath, [fileURLToPath(new URL("./telemetry-oracle-check.mjs", import.meta.url))], {
    encoding: "utf8", env: { ...process.env, GITHUB_STEP_SUMMARY: summaryPath },
  });
  assert.equal(result.status, 0, result.stderr);
  const summary = fs.readFileSync(summaryPath, "utf8");
  assert.match(summary, /^## Telemetry analytics oracle\n\n✅ Passed\n\n9 cases · 879 raw events · 204 condition rows · 21 marker comparisons · 32 regression groups\n$/);
  assert.match(result.stdout, /telemetry oracle: PASS/);
  console.log("telemetry oracle job summary: ok");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}
