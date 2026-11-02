#!/usr/bin/env node
// Enabling a built-in package's own MCP preset must NOT record a workspace MCP entry. The preset
// already lives in the app's manifests/inventory/mcp-servers.json; recording it into the user
// workspace would duplicate a built-in and trip assertMcpRecordAllowed in package mode (the guard
// that stops USERS from shadowing a built-in). Regression guard for the crash where enabling an MCP
// package / a portal package toggle threw mid-wiring and left the package `[partial]`.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeAppRoot } from "./app-root-fixture.mjs";

// The fixture-tool package is the built-in MCP package here: it ships only in this isolated app root.
const appRoot = makeAppRoot({ prefix: "roborepo-mcp-builtin-app-", fixturePackages: true });
const cli = path.join(appRoot, "scripts", "cli", "main.mjs");

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-builtin-"));
try {
  const home = path.join(tmp, "home");
  const fakeBin = path.join(tmp, "bin");
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.mkdirSync(fakeBin, { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), '{"permissions":{"allow":[]}}\n');
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
  // Fake `claude` so the live `mcp add` subprocess succeeds without a real CLI or network.
  fs.writeFileSync(path.join(fakeBin, "claude"), "#!/usr/bin/env bash\nexit 0\n");
  fs.chmodSync(path.join(fakeBin, "claude"), 0o755);

  const env = {
    ...process.env,
    HOME: home,
    PATH: `${fakeBin}:${process.env.PATH}`,
    ROBOREPO_APP_ROOT: appRoot,
    ROBOREPO_MODE: "package",
    ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
  };

  spawnSync(process.execPath, [cli, "setup"], { env, encoding: "utf8" });

  // The regression: this used to throw "MCP server '<preset>' is built in; add a typed mcp-server
  // replace override" after already writing the MCP, exiting non-zero and leaving partial state.
  const result = spawnSync(process.execPath, [cli, "package", "enable", "fixture-tool"], { env, encoding: "utf8" });
  assert.equal(
    result.status,
    0,
    `enable of a built-in MCP package must succeed in package mode (got ${result.status}): ${result.stderr}`,
  );
  assert.doesNotMatch(
    `${result.stdout}${result.stderr}`,
    /is built in; add a typed mcp-server replace override/,
    "the built-in guard must not fire when the package system wires its own preset",
  );

  // The built-in must not be duplicated into the user workspace record.
  const workspaceMcp = path.join(home, ".roborepo", "workspace", "mcp", "servers.json");
  const record = JSON.parse(fs.readFileSync(workspaceMcp, "utf8"));
  assert.ok(
    !record.servers.some((s) => s.name === "fixture-tool"),
    "built-in preset must not be recorded into the workspace MCP file",
  );

  console.log("mcp-builtin-record-skip ok");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.rmSync(appRoot, { recursive: true, force: true });
}
