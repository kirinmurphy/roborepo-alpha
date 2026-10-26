#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-root-config-write-policy-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_DIR = path.join(tmp, ".roborepo");

const { writeRootConfig } = await import("../cli/root-config-writes.mjs");
const { renderClaudeSettings } = await import("../cli/permissions-render.mjs");

const claudeSettings = path.join(tmp, ".claude", "settings.json");
writeRootConfig("claude", claudeSettings, JSON.stringify({ model: "opus", hooks: { Stop: [] } }, null, 2));
assert.equal(JSON.parse(fs.readFileSync(claudeSettings, "utf8")).model, undefined,
  "active Claude root-config writes must strip global model");

const rendered = JSON.parse(renderClaudeSettings(
  JSON.stringify({ model: "opus", hooks: { Stop: [] } }),
  { behaviors: [], commands: { allow: [] } },
));
assert.equal(rendered.model, undefined, "permission renderer must strip global Claude model");
assert.deepEqual(rendered.hooks, { Stop: [] }, "permission renderer still preserves other settings");

console.log("root-config-write-policy ok");
