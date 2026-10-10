#!/usr/bin/env node
// Characterizes scripts/cli/mcp.mjs's mcpAdd (the `roborepo mcp add` CLI path) through
// getHarnessProvider(id).adapters.mcp.addServer dispatch. Pins the dry-run display text (still must read "claude mcp add
// ..."), repeatable --harness <id> gating (the --only-claude/--only-codex replacement -- omitting
// --harness means every registered harness, a given --harness always narrows to exactly the ids
// named), a real (non-dry-run) Codex-only add's on-disk TOML output, and a real (non-dry-run)
// Gemini-only add's on-disk mcpServers JSON output (mcpAdd previously only had Claude/Codex branches at all, a real bug this fixes: `--harness
// gemini` used to silently do nothing). Claude's real (non-dry-run) add shells to the actual
// `claude` CLI and calls process.exit(0), so it is not exercised here -- covered instead by
// harness-mcp-remove-characterization-check.mjs (removal) and mcp-claude-permission-check.mjs (the
// permission-grant side effect), both of which don't require a live `claude` binary.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

// recordMcpServer (mcp.mjs) writes to MCP_SERVERS_PATH (dev-checkout mode) or
// workspaceMcpServersPath (package mode) -- MCP_SERVERS_PATH resolves under ROBOREPO_APP_ROOT, so
// without a fake app root a real (non-dry-run) `mcp add` run would record into THIS repo's
// tracked manifests/inventory/mcp-servers.json. Every test below must run against an isolated
// copied app root, never the real repoRoot.
import { makeAppRoot } from "./app-root-fixture.mjs";

// Local makeHome on purpose: this check also seeds a ~/.gemini root config, which the shared
// makeHome() does not.
function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-add-char-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  fs.mkdirSync(path.join(tmp, ".gemini"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".gemini", "settings.json"), "{}");
  return tmp;
}

const appRoot = makeAppRoot();
const cli = path.join(appRoot, "scripts", "cli", "main.mjs");

function run(home, args) {
  const env = { ...process.env, HOME: home, ROBOREPO_APP_ROOT: appRoot, ROBOREPO_MODE: "development", ROBOREPO_STATE_DIR: path.join(home, ".roborepo") };
  return spawnSync(process.execPath, [cli, "mcp", "add", ...args], { env, encoding: "utf8" });
}

// --- Dry-run, every registered harness: prints the claude CLI invocation text, the Codex dry-run
// line, and the Gemini dry-run line ---
{
  const home = makeHome();
  try {
    const result = run(home, ["--dry-run", "--name=char-test", "char-test-mcp"]);
    assert.equal(result.status, 0, `dry-run should exit 0: ${result.stderr}`);
    assert.match(result.stdout, /^claude mcp add --scope user char-test -- uvx char-test-mcp$/m, "dry-run prints the claude CLI invocation");
    assert.match(result.stdout, /would add permission: mcp__char-test/, "dry-run prints the Claude permission-grant line");
    assert.match(result.stdout, /would add Codex MCP: char-test/, "dry-run prints the Codex add line");
    assert.match(result.stdout, /would add Gemini MCP: char-test/, "dry-run prints the Gemini add line");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Real (non-dry-run), --harness gemini: writes mcpServers JSON, Claude/Codex configs untouched ---
{
  const home = makeHome();
  try {
    const claudeBefore = fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8");
    const codexBefore = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    const result = run(home, ["--harness", "gemini", "--name=char-test-gemini", "char-test-mcp"]);
    assert.equal(result.status, 0, `--harness gemini add should exit 0: ${result.stderr}`);
    assert.match(result.stdout, /gemini MCP added: char-test-gemini/, "--harness gemini prints the gemini add confirmation");

    const settings = JSON.parse(fs.readFileSync(path.join(home, ".gemini", "settings.json"), "utf8"));
    assert.deepEqual(settings.mcpServers["char-test-gemini"], { command: "uvx", args: ["char-test-mcp"] }, "Gemini's mcpServers entry matches the real `gemini mcp add` CLI's own output shape");

    assert.equal(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"), claudeBefore, "--harness gemini must never touch the Claude settings");
    assert.equal(fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"), codexBefore, "--harness gemini must never touch the Codex config");

    // Re-running the same add must detect the existing entry, not duplicate or error.
    const again = run(home, ["--harness", "gemini", "--name=char-test-gemini", "char-test-mcp"]);
    assert.equal(again.status, 0, "re-adding the same gemini server should still exit 0");
    assert.match(again.stdout, /gemini MCP already present: char-test-gemini/, "re-adding an existing gemini server reports already-present, not a duplicate write");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Dry-run, --harness codex: no Claude lines at all ---
{
  const home = makeHome();
  try {
    const result = run(home, ["--dry-run", "--harness", "codex", "--name=char-test-codex", "char-test-mcp"]);
    assert.equal(result.status, 0, `dry-run should exit 0: ${result.stderr}`);
    assert.doesNotMatch(result.stdout, /^claude mcp add/m, "--harness codex dry-run must not print the claude CLI line");
    assert.doesNotMatch(result.stdout, /would add permission/, "--harness codex dry-run must not print the permission line");
    assert.match(result.stdout, /would add Codex MCP: char-test-codex/, "--harness codex dry-run still prints the Codex add line");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Real (non-dry-run), --harness claude: Codex config.toml must be untouched ---
{
  const home = makeHome();
  try {
    const before = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    // --harness claude shells to the real `claude` binary, which may not exist in CI/sandboxed runs --
    // accept either a clean exit (claude present) or a spawn/exec failure (claude absent), but in
    // both cases Codex's config must be untouched, since --harness claude alone must never call
    // ensureCodexMcp.
    run(home, ["--harness", "claude", "--name=char-test-claude-only", "char-test-mcp"]);
    const after = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.equal(after, before, "--harness claude must never touch the Codex config");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- --harness claude --harness codex repeated: equivalent to omitting the flag, not an error ---
{
  const home = makeHome();
  try {
    const result = run(home, ["--dry-run", "--harness", "claude", "--harness", "codex", "--name=char-test-both", "char-test-mcp"]);
    assert.equal(result.status, 0, `repeated --harness for every registered id must succeed: ${result.stderr}`);
    assert.match(result.stdout, /^claude mcp add/m, "repeated --harness claude codex still prints the claude CLI line");
    assert.match(result.stdout, /would add Codex MCP: char-test-both/, "repeated --harness claude codex still prints the Codex add line");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- --harness with a missing value must error, not silently mean "all" ---
{
  const home = makeHome();
  try {
    const result = run(home, ["--harness"]);
    assert.notEqual(result.status, 0, "--harness with no value must fail");
    assert.match(result.stderr, /--harness requires a value/, "missing --harness value must explain why");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- --harness with an unregistered id must be rejected ---
{
  const home = makeHome();
  try {
    const result = run(home, ["--harness", "nonexistent", "--name=x", "x"]);
    assert.notEqual(result.status, 0, "unknown --harness id must fail");
    assert.match(result.stderr, /unknown harness: nonexistent/, "unknown --harness id must name the bad value");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

fs.rmSync(appRoot, { recursive: true, force: true });
console.log("mcp-add-characterization-check: ok");
