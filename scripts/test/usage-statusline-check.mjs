#!/usr/bin/env node
// Process-level + lifecycle tests for the usage-statusline package: the installed Claude command's
// stdin/stdout/NO_COLOR/invalid-JSON behavior, and package enable/disable ownership (runtime
// modules, Claude singleton, Codex migration to context-used, and the owned color scalar). Pure
// domain/render/store/API assertions live in usage-domain-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const formatter = path.join(repoRoot, "globals/packages/usage-statusline/scripts/claude-statusline.mjs");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

const RUNTIME_MODULES = [
  "claude-statusline.mjs",
  "usage-adapters.mjs",
  "usage-domain.mjs",
  "usage-render.mjs",
  "usage-snapshot-store.mjs",
];

// --- installed command: stdin -> single line, NO_COLOR, invalid JSON --------
function runFormatter(input, env = {}) {
  return spawnSync(process.execPath, [formatter], { input, encoding: "utf8", env: { ...process.env, ...env } });
}

{
  const home = makeHome();
  try {
    const run = runFormatter(
      JSON.stringify({ context_window: { used_percentage: 70 } }),
      { NO_COLOR: "", ROBOREPO_STATE_DIR: path.join(home, ".roborepo") },
    );
    assert.equal(run.status, 0, "formatter succeeds with NO_COLOR");
    // Matches the format the implementation plan specifies ("Context: 42% · 5h: — · Weekly: —").
    // This assertion originally expected "70% used"; the renderer has emitted a bare percentage
    // since the feature's first commit, so the expectation was wrong when written rather than
    // drifting later. Corrected to the specified format, not to whatever the renderer happens to do.
    assert.equal(run.stdout.trim(), "Context: 70% · 5h: — · Weekly: —", "NO_COLOR emits the plain one-line format");
    assert.equal(run.stdout.split("\n").filter(Boolean).length, 1, "exactly one output line");
    // Best-effort snapshot persistence happened as a side effect.
    assert.ok(fs.existsSync(path.join(home, ".roborepo", "usage", "latest", "claude.json")), "entrypoint persists a snapshot");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}
{
  const invalid = runFormatter("{ nope");
  assert.notEqual(invalid.status, 0, "invalid JSON fails");
  assert.equal(invalid.stdout, "", "invalid JSON writes no stdout");
  assert.match(invalid.stderr, /invalid JSON input/, "invalid JSON prints concise diagnostic");
  assert.doesNotMatch(invalid.stderr, /\{ nope/, "invalid JSON does not echo input");
}

// --- lifecycle: enable/disable ownership ------------------------------------
{
  const home = makeHome();
  try {
    const env = { ...process.env, HOME: home, ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), SKIP_MCP: "1" };
    const enable = spawnSync(process.execPath, [cli, "package", "enable", "usage-statusline"], { env, encoding: "utf8" });
    assert.equal(enable.status, 0, `enable should succeed:\n${enable.stderr}\n${enable.stdout}`);

    // All runtime modules copied to managed storage (not just the entrypoint).
    for (const mod of RUNTIME_MODULES) {
      assert.ok(fs.existsSync(path.join(home, ".roborepo", "package-runtime", "usage-statusline", mod)), `enable installs ${mod}`);
    }
    const entrypoint = path.join(home, ".roborepo", "package-runtime", "usage-statusline", "claude-statusline.mjs");
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, `node "${entrypoint}"`, "Claude command references managed entrypoint");

    // Codex footer stays fully native until an upstream footer-command hook exists.
    // No used-direction / pacing / scalar
    // changes are applied to Codex, so the enhancement never ships a mixed used/remaining footer.
    const codexConfig = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    for (const item of ["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "git-branch"]) {
      assert.match(codexConfig, new RegExp(JSON.stringify(item)), `Codex status_line contains native ${item}`);
    }
    assert.doesNotMatch(codexConfig, /"context-used"/, "Codex is not migrated to context-used (deferred to hook)");
    assert.doesNotMatch(codexConfig, /status_line_use_colors/, "Codex decorative-color scalar is not touched (deferred to hook)");

    // Idempotent re-enable.
    const reEnable = spawnSync(process.execPath, [cli, "package", "enable", "usage-statusline"], { env, encoding: "utf8" });
    assert.equal(reEnable.status, 0, "re-enable is idempotent");

    const disable = spawnSync(process.execPath, [cli, "package", "disable", "usage-statusline"], { env, encoding: "utf8" });
    assert.equal(disable.status, 0, `disable should succeed:\n${disable.stderr}\n${disable.stdout}`);
    const after = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(after.statusLine, undefined, "disable removes owned Claude statusLine");
    for (const mod of RUNTIME_MODULES) {
      assert.ok(!fs.existsSync(path.join(home, ".roborepo", "package-runtime", "usage-statusline", mod)), `disable removes ${mod}`);
    }
    const afterCodex = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    for (const item of ["model-with-reasoning", "context-remaining", "five-hour-limit", "weekly-limit", "git-branch"]) {
      assert.doesNotMatch(afterCodex, new RegExp(JSON.stringify(item)), `disable removes native ${item}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Claude singleton conflict preserved ------------------------------------
{
  const home = makeHome();
  try {
    fs.writeFileSync(
      path.join(home, ".claude", "settings.json"),
      `${JSON.stringify({ statusLine: { type: "command", command: "custom-status" } }, null, 2)}\n`,
    );
    const env = { ...process.env, HOME: home, ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), SKIP_MCP: "1" };
    const enable = spawnSync(process.execPath, [cli, "package", "enable", "usage-statusline"], { env, encoding: "utf8" });
    assert.equal(enable.status, 0, `conflict enable should report but not fail:\n${enable.stderr}\n${enable.stdout}`);
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.statusLine.command, "custom-status", "unmanaged Claude statusLine is preserved");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-usage-statusline-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}\n");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  return tmp;
}

console.log("ok: usage statusline package (entrypoint + lifecycle)");