#!/usr/bin/env node
// ensureClaudeMcpPermission must write the grant to the ACTIVE Claude settings
// (~/.claude/settings.json) — the file the harness reads — and record its drift hash, never the
// repo baseline template. Regression guard for the package-mode leak where the permission was
// written into appRoot/generated/claude/settings.json (release/tracked files).
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-claude-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_DIR = path.join(tmp, ".roborepo");
process.env.ROBOREPO_MODE = "package";

const claudeDir = path.join(tmp, ".claude");
const activeSettings = path.join(claudeDir, "settings.json");
fs.mkdirSync(claudeDir, { recursive: true });

const { ensureClaudeMcpPermission } = await import("../cli/mcp-claude.mjs");
const { writeRootConfig } = await import("../cli/root-config-writes.mjs");
const { checkDrift } = await import("../cli/root-config-state.mjs");
const { rootConfigBaseline } = await import("../cli/paths.mjs");

// Seed the active file the way install does — through writeRootConfig so its drift hash is recorded.
// A hand-written file that diverges from the baseline is intentionally NOT recorded (roborepo must
// not clobber user edits), so recording is only guaranteed off a roborepo-owned write.
writeRootConfig("claude", activeSettings, `${JSON.stringify({ permissions: { allow: ["Read"] } }, null, 2)}\n`);
assert.equal(checkDrift("claude", activeSettings).status, "clean", "seed write records the active hash");

const baselineBefore = fs.readFileSync(rootConfigBaseline.claude, "utf8");

ensureClaudeMcpPermission("unit-server");

const active = JSON.parse(fs.readFileSync(activeSettings, "utf8"));
assert.ok(
  active.permissions.allow.includes("mcp__unit-server"),
  "permission grant lands in the active Claude settings",
);
assert.deepEqual(
  active.permissions.allow,
  ["mcp__unit-server", "Read"],
  "grant is prepended ahead of the existing non-mcp allows",
);
assert.equal(
  checkDrift("claude", activeSettings).status,
  "clean",
  "permission write re-records the active root-config hash",
);
assert.equal(
  fs.readFileSync(rootConfigBaseline.claude, "utf8"),
  baselineBefore,
  "package-mode permission write never mutates the repo baseline",
);

// Idempotent: a second grant of the same server is a no-op that leaves the file unchanged.
const afterFirst = fs.readFileSync(activeSettings, "utf8");
ensureClaudeMcpPermission("unit-server");
assert.equal(
  fs.readFileSync(activeSettings, "utf8"),
  afterFirst,
  "re-granting an existing permission is a no-op",
);

console.log("mcp-claude-permission ok");
