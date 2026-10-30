#!/usr/bin/env node
// A failing `claude mcp add` must not end the process that called the Claude MCP adapter: package
// enable runs inside the portal server and reports the package `blocked`. Only the terminal
// `roborepo mcp add` turns the failure into an exit, with the CLI's own status.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { makeAppRoot } from "./app-root-fixture.mjs";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-mcp-claude-fail-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));

// `claude` stand-in on PATH: answers `--version` so discovery validates it, and fails `mcp add`
// with status 3.
const bin = path.join(tmp, "bin");
fs.mkdirSync(bin);
fs.writeFileSync(path.join(bin, "claude"), `#!/bin/sh
if [ "$1" = "--version" ]; then echo "1.0.0 (Claude Code)"; exit 0; fi
echo 'fake claude failure' >&2
exit 3
`, { mode: 0o755 });
fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");

process.env.HOME = tmp;
process.env.PATH = `${bin}${path.delimiter}${process.env.PATH}`;
process.env.ROBOREPO_STATE_ROOT = path.join(tmp, ".roborepo");

const { getHarnessProvider } = await import("../harnesses/registry.mjs");
const spec = { name: "fail-test", commandOrUrl: "uvx", args: ["fail-test-mcp"] };
const result = getHarnessProvider("claude").adapters.mcp.addServer(spec, { scope: "user", transport: null });
assert.equal(result.ok, false, "a failing claude mcp add returns ok:false");
assert.equal(result.changed, false);
assert.equal(result.exitStatus, 3, "the CLI's exit status rides on the result");
assert.match(result.warnings.join("\n"), /status 3/);

const appRoot = makeAppRoot();
const cli = path.join(appRoot, "scripts", "cli", "main.mjs");
const env = { ...process.env, ROBOREPO_APP_ROOT: appRoot, ROBOREPO_MODE: "development" };
const add = spawnSync(process.execPath, [cli, "mcp", "add", "--harness", "claude", "--name=fail-test", "fail-test-mcp"], { env, encoding: "utf8" });
assert.equal(add.status, 3, `mcp add exits with the claude CLI's status: ${add.stderr}`);
assert.match(add.stderr, /claude mcp add exited with status 3/);

// Package enable maps the same failure to a `blocked` outcome and exits 1 on its own terms.
const pkgHome = path.join(tmp, "pkg-home");
fs.mkdirSync(path.join(pkgHome, ".claude"), { recursive: true });
fs.mkdirSync(path.join(pkgHome, ".codex"), { recursive: true });
fs.writeFileSync(path.join(pkgHome, ".claude", "settings.json"), '{"permissions":{"allow":[]}}\n');
fs.writeFileSync(path.join(pkgHome, ".codex", "config.toml"), "");
// No shipped package carries an MCP server, so the test-only fixture-tool package supplies one.
const fixtureAppRoot = makeAppRoot({ fixturePackages: true });
const pkgEnv = { ...process.env, HOME: pkgHome, ROBOREPO_APP_ROOT: fixtureAppRoot, ROBOREPO_MODE: "development", ROBOREPO_STATE_ROOT: path.join(pkgHome, ".roborepo") };
const fixtureCli = path.join(fixtureAppRoot, "scripts", "cli", "main.mjs");
const enable = spawnSync(process.execPath, [fixtureCli, "package", "enable", "fixture-tool"], { env: pkgEnv, encoding: "utf8" });
const enableOutput = `${enable.stdout}${enable.stderr}`;
assert.equal(enable.status, 1, `a blocked enable exits 1: ${enableOutput}`);
assert.match(enableOutput, /blocked/, "package enable reports the package blocked");
assert.match(enableOutput, /claude mcp add exited with status 3/, "the blocked message carries the CLI failure");
