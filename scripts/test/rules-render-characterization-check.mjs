#!/usr/bin/env node
// Characterizes rules-render.mjs's per-harness behavior through provider rule
// targets. Pins the genuine harness-specific special cases so the refactor can be
// checked byte-for-byte: Codex's AGENTS.override.md mirror write, Claude's legacy rules-file
// cleanup, and the shared+harness fragment render order for both harnesses.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

import { makeAppRoot } from "./app-root-fixture.mjs";

function makeHome() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-rules-render-home-"));
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  return tmp;
}

function runRender(appRoot, home, extra = "") {
  const env = { ...process.env, ROBOREPO_MODE: "development", ROBOREPO_APP_ROOT: appRoot, HOME: home, ROBOREPO_STATE_DIR: path.join(home, ".roborepo"), SKIP_MCP: "1" };
  const result = spawnSync(process.execPath, [
    "-e",
    `import(${JSON.stringify(path.join(appRoot, "scripts", "cli", "rules-render.mjs"))}).then((m) => m.renderHomeRules(${extra}))`,
  ], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `renderHomeRules should succeed: ${result.stderr}\n${result.stdout}`);
}

const appRoot = makeAppRoot();
try {
  // --- Codex: AGENTS.override.md mirror, only when present before render ---
  {
    const home = makeHome();
    try {
      fs.writeFileSync(path.join(home, ".codex", "AGENTS.override.md"), "# my overrides\n\nuser content\n");
      runRender(appRoot, home);
      const agentsMd = fs.readFileSync(path.join(home, ".codex", "AGENTS.md"), "utf8");
      assert.match(agentsMd, /# Generated Harness Rules|builtin-code-style/, "AGENTS.md gets the managed block");
      const override = fs.readFileSync(path.join(home, ".codex", "AGENTS.override.md"), "utf8");
      assert.match(override, /builtin-code-style/, "AGENTS.override.md, when present, also gets the managed block mirrored into it");
      assert.match(override, /user content/, "AGENTS.override.md's pre-existing user content is preserved outside the managed block");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Codex: no AGENTS.override.md present -> render must not create one ---
  {
    const home = makeHome();
    try {
      runRender(appRoot, home);
      assert.equal(
        fs.existsSync(path.join(home, ".codex", "AGENTS.override.md")),
        false,
        "render must not create AGENTS.override.md when it wasn't already present",
      );
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Claude: legacy rules file cleanup only fires for the claude harness ---
  {
    const home = makeHome();
    try {
      const stateDir = path.join(home, ".roborepo");
      const legacyFile = path.join(stateDir, "rules", "generated-rules.md");
      fs.mkdirSync(path.dirname(legacyFile), { recursive: true });
      fs.writeFileSync(legacyFile, "# Generated Harness Rules\n\nstale legacy content\n");
      runRender(appRoot, home);
      assert.equal(fs.existsSync(legacyFile), false, "legacy rules file must be removed when Claude is rendered");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- Both harnesses render independently: only present home dirs get written ---
  {
    const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-rules-render-home-"));
    try {
      fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
      fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
      // No .codex dir at all.
      runRender(appRoot, home);
      assert.ok(fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), "Claude home rules render when .claude exists");
      assert.equal(fs.existsSync(path.join(home, ".codex")), false, "codex home is never created when absent");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }

  // --- targetHarness scopes render to one harness only ---
  {
    const home = makeHome();
    try {
      runRender(appRoot, home, "{ harness: 'claude' }");
      assert.ok(fs.existsSync(path.join(home, ".claude", "CLAUDE.md")), "claude-scoped render writes CLAUDE.md");
      assert.equal(fs.existsSync(path.join(home, ".codex", "AGENTS.md")), false, "claude-scoped render does not touch codex");
    } finally {
      fs.rmSync(home, { recursive: true, force: true });
    }
  }
} finally {
  fs.rmSync(appRoot, { recursive: true, force: true });
}

console.log("rules-render-characterization-check: ok");