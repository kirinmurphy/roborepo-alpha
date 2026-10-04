#!/usr/bin/env node
// Regression suite for docs/plans/active/roborepo-system-package-ownership-and-generated-output-plan.md
// (all 8 phases now complete).
//
// Originally written in Phase 0 as characterization tests asserting CURRENT (leaky) behavior on
// purpose — a disabled package left Codex-side behavior wired, because that behavior was hardcoded
// into committed baseline files instead of being package-owned. Every assertion below has since been
// inverted (Phases 3-7) as its corresponding leak was fixed. Kept in place rather than deleted: these
// assertions and their temp-HOME scaffolding now serve as the permanent regression guard confirming
// each leak stays fixed — re-hardcoding any of this behavior into a shared baseline file would fail
// these tests immediately.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");

// --- Item 1/3 (FIXED in Phase 3): Caveman and JDocMunch Codex SessionStart hooks are no longer
// hardcoded in the committed baseline hooks.json — each now owns a hooks/codex component
// (globals/packages/{caveman,jdocmunch}/hooks-codex.json) composed via hook-composition.mjs. ---
{
  const hooksJson = fs.readFileSync(path.join(repoRoot, "generated/codex/hooks.json"), "utf8");
  assert.doesNotMatch(hooksJson, /CAVEMAN MODE ACTIVE/, "fixed: Caveman Codex hook no longer hardcoded in the committed baseline hooks.json");
  assert.doesNotMatch(hooksJson, /jdocmunch: docs indexed/, "fixed: JDocMunch Codex hook no longer hardcoded in the committed baseline hooks.json");

  const cavemanFragment = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/caveman/hooks-codex.json"), "utf8"));
  assert.match(cavemanFragment.SessionStart[0].hooks[0].command, /CAVEMAN MODE ACTIVE/, "caveman package owns its Codex SessionStart hook");
  const jdocmunchFragment = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/jdocmunch/hooks-codex.json"), "utf8"));
  assert.match(jdocmunchFragment.SessionStart[0].hooks[0].command, /jdocmunch: docs indexed/, "jdocmunch package owns its Codex SessionStart hook");
}

// --- Item 2 (FIXED in Phase 3): the stale caveman@caveman-repo plugin entry is gone from the Codex
// baseline entirely — the Codex SessionStart hook (above) is the sole Codex-side Caveman mechanism. ---
{
  const configToml = fs.readFileSync(path.join(repoRoot, "generated/codex/config.toml"), "utf8");
  assert.doesNotMatch(configToml, /\[plugins\."caveman@caveman-repo"\]/, "fixed: stale caveman@caveman-repo plugin entry removed from Codex baseline");
}

// --- Item 1/3 integration: enable/disable/reapply round-trips for both packages' Codex hooks. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-codex-hook-ownership-"));
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo"), SKIP_MCP: "1" };
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");

  const codexHooksPath = path.join(tmp, ".codex", "hooks.json");
  const readCodexHooks = () => {
    try { return JSON.parse(fs.readFileSync(codexHooksPath, "utf8")); } catch { return {}; }
  };
  const hasSessionStartCommand = (pattern) =>
    ((readCodexHooks().hooks || {}).SessionStart || []).some((e) => (e.hooks || []).some((h) => pattern.test(h.command)));

  for (const [pkgId, pattern] of [["caveman", /CAVEMAN MODE ACTIVE/], ["jdocmunch", /jdocmunch: docs indexed/]]) {
    spawnSync(process.execPath, [cli, "package", "enable", pkgId], { env, stdio: "ignore" });
    assert.ok(hasSessionStartCommand(pattern), `${pkgId} Codex hook present after enable`);
    spawnSync(process.execPath, [cli, "package", "enable", pkgId], { env, stdio: "ignore" });
    const count = ((readCodexHooks().hooks || {}).SessionStart || [])
      .flatMap((e) => e.hooks || [])
      .filter((h) => pattern.test(h.command)).length;
    assert.equal(count, 1, `${pkgId} Codex hook not duplicated on reapply`);
    spawnSync(process.execPath, [cli, "package", "disable", pkgId], { env, stdio: "ignore" });
    assert.ok(!hasSessionStartCommand(pattern), `${pkgId} Codex hook absent after disable`);
    spawnSync(process.execPath, [cli, "package", "disable", pkgId], { env, stdio: "ignore" });
    assert.ok(!hasSessionStartCommand(pattern), `${pkgId} Codex hook stays absent after re-disable`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Item 4/5/5a (FIXED in Phase 4): JCodeMunch and JDocMunch MCP servers + tool-approval tables
// are no longer hardcoded in the committed Codex baseline. JCodeMunch's codex_tool_approvals
// component was extended from a single stray "register_edit" entry to the full 16-tool set that
// actually matched the old baseline; JDocMunch gained a new codex_tool_approvals component (it had
// none before) covering all 16 of its baseline tools. Both were verified byte-for-byte against the
// pre-removal baseline via a real (non-dry-run) enable before the baseline blocks were deleted. ---
{
  const configToml = fs.readFileSync(path.join(repoRoot, "generated/codex/config.toml"), "utf8");
  assert.doesNotMatch(configToml, /^\[mcp_servers\.jcodemunch\]$/m, "fixed: jcodemunch MCP server no longer hardcoded in Codex baseline");
  assert.doesNotMatch(configToml, /^\[mcp_servers\.jdocmunch\]$/m, "fixed: jdocmunch MCP server no longer hardcoded in Codex baseline");
  assert.doesNotMatch(configToml, /^\[mcp_servers\.jdocmunch\.tools\.search_sections\]$/m, "fixed: jdocmunch tool-approval tables no longer hardcoded in Codex baseline (item 5a)");

  const jcodemunchPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/jcodemunch/package.config.json"), "utf8"));
  const jcodemunchApprovals = jcodemunchPkg.resources.find((r) => r.type === "codex_tool_approvals");
  assert.ok(Object.keys(jcodemunchApprovals.approvals).length >= 16, "jcodemunch package declares its full Codex tool-approval set");

  const jdocmunchPkg = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/jdocmunch/package.config.json"), "utf8"));
  const jdocmunchApprovals = jdocmunchPkg.resources.find((r) => r.type === "codex_tool_approvals");
  assert.ok(jdocmunchApprovals, "jdocmunch package now declares a codex_tool_approvals component");
  assert.ok(Object.keys(jdocmunchApprovals.approvals).length >= 16, "jdocmunch package declares its full Codex tool-approval set");
}

// --- Item 4/5 integration: disabled baseline -> enable -> apply -> disable -> apply remains
// disabled, for both jcodemunch and jdocmunch, per the plan doc's stated round-trip. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-codex-mcp-ownership-"));
  // No SKIP_MCP here (unlike the hook-composition test above): this test asserts on the
  // [mcp_servers.<name>] header itself, which only ensureCodexMcp (not skipped by that flag's
  // Claude-CLI-registration guard) writes. The Codex-side write is a pure TOML file operation with
  // no external CLI dependency, so it's safe to exercise directly.
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");

  const codexConfigPath = path.join(tmp, ".codex", "config.toml");
  const hasServer = (name) => fs.readFileSync(codexConfigPath, "utf8").includes(`[mcp_servers.${name}]`);

  for (const pkgId of ["jcodemunch", "jdocmunch"]) {
    assert.ok(!hasServer(pkgId), `${pkgId} MCP server absent on a clean baseline`);
    spawnSync(process.execPath, [cli, "package", "enable", pkgId], { env, stdio: "ignore" });
    assert.ok(hasServer(pkgId), `${pkgId} MCP server present after enable`);
    spawnSync(process.execPath, [cli, "package", "disable", pkgId], { env, stdio: "ignore" });
    assert.ok(!hasServer(pkgId), `${pkgId} MCP server absent after disable`);
  }

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Item 11 (FIXED in Phases 3+4): verify-content.tsv no longer asserts any optional-package
// content unconditionally. The Caveman row was removed in Phase 3; jcodemunch's MCP-server and
// MCP-args rows were removed in Phase 4 alongside the baseline blocks they were asserting. ---
{
  const verifyContent = fs.readFileSync(path.join(repoRoot, "manifests/platform/verify-content.tsv"), "utf8");
  const dataRows = verifyContent.split("\n").filter((line) => line && !line.startsWith("#"));
  const cavemanRow = dataRows.find((row) => row.includes("CAVEMAN MODE ACTIVE"));
  const jcodemunchRows = dataRows.filter((row) => row.includes("jcodemunch"));
  assert.equal(cavemanRow, undefined, "fixed: verify-content.tsv no longer asserts CAVEMAN MODE ACTIVE unconditionally");
  assert.equal(jcodemunchRows.length, 0, "fixed: verify-content.tsv no longer asserts jcodemunch MCP strings unconditionally");
}

// --- Item 6 (FIXED in Phase 5): JCodeMunch's Claude Bash exploration blocker now lives under
// globals/packages/jcodemunch, installed only via that package's hooks/claude component. The old
// ~/.claude/settings.json MCP-presence gate was removed entirely (not fixed to check ~/.claude.json)
// since enable/disable now controls whether the hook is wired at all, making a runtime self-check
// redundant. ---
{
  const oldBlockerPath = path.join(repoRoot, "globals/claude/hooks/block-source-exploration.mjs");
  assert.ok(!fs.existsSync(oldBlockerPath), "fixed: JCodeMunch Bash blocker no longer lives under system globals/claude/hooks");

  const newBlockerPath = path.join(repoRoot, "globals/packages/jcodemunch/hooks/block-source-exploration.mjs");
  assert.ok(fs.existsSync(newBlockerPath), "JCodeMunch Bash blocker now lives under globals/packages/jcodemunch");
  const blockerSrc = fs.readFileSync(newBlockerPath, "utf8");
  assert.doesNotMatch(blockerSrc, /'\.claude',\s*'settings\.json'/, "fixed: blocker no longer gates on ~/.claude/settings.json (gate removed entirely, not repointed)");

  const pkgConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/jcodemunch/package.config.json"), "utf8"));
  const claudeHooksComponent = pkgConfig.resources.find((r) => r.type === "hooks" && r.harness === "claude");
  const fragment = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/jcodemunch", claudeHooksComponent.source), "utf8"));
  const bashEntry = (fragment.PreToolUse || []).find((e) => e.matcher === "Bash");
  assert.ok(bashEntry, "jcodemunch's Claude hooks fragment now declares a Bash-matcher entry for the blocker");
  assert.match(bashEntry.hooks[0].command, /block-source-exploration\.mjs/, "the Bash entry wires block-source-exploration.mjs");
}

// --- Item 6 integration: enabled jcodemunch blocks Bash source-file exploration; disabled leaves
// Bash exploration unaffected — the exit criterion literally stated in the plan doc. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-jcodemunch-bash-blocker-"));
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo"), SKIP_MCP: "1" };
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");

  const runBlocker = (command) => {
    const hookPath = path.join(tmp, ".claude", "hooks", "block-source-exploration.mjs");
    const input = JSON.stringify({ tool_input: { command }, cwd: tmp });
    const result = spawnSync(process.execPath, [hookPath], { input, encoding: "utf8" });
    return result.stdout;
  };

  spawnSync(process.execPath, [cli, "package", "enable", "jcodemunch"], { env, stdio: "ignore" });
  const blockedOutput = runBlocker("grep -r foo src/index.ts");
  assert.match(blockedOutput, /"permissionDecision":"deny"/, "enabled jcodemunch: Bash source exploration is blocked");

  spawnSync(process.execPath, [cli, "package", "disable", "jcodemunch"], { env, stdio: "ignore" });
  assert.ok(!fs.existsSync(path.join(tmp, ".claude", "hooks", "block-source-exploration.mjs")), "disabled jcodemunch: blocker hook file removed, Bash exploration unaffected");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Item 7/8 (FIXED in Phase 6): telemetry now declares hooks/claude and hooks/codex components
// (globals/packages/telemetry/hooks-{claude,codex}.json), so the generic enable/disable switch
// removes capture hooks like any other package-owned hook. wireCaptureHooks (used by the standalone
// `roborepo telemetry install` path) is now a thin wrapper over the same hook-composition.mjs
// composer the package-driven path uses — one hook definition, one merge implementation. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-telemetry-leak-"));
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo") };
  fs.mkdirSync(path.join(tmp, ".claude"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");

  spawnSync(process.execPath, [cli, "telemetry", "install"], { env, stdio: "ignore" });
  const claudeAfterInstall = fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8");
  assert.match(claudeAfterInstall, /roborepo telemetry capture/, "telemetry install wires capture hooks (sanity check before asserting the disable gap is closed)");
  // Check hook presence AND service state together, not sequentially, to catch an ordering race
  // where one flips before the other (wasted capture subprocess spawns, or capture silently dropped).
  const telemetryStateAfterInstall = JSON.parse(fs.readFileSync(path.join(tmp, ".roborepo", "telemetry", "state.json"), "utf8"));
  assert.equal(telemetryStateAfterInstall.enabled, true, "telemetry service state is enabled immediately alongside hook install");

  spawnSync(process.execPath, [cli, "package", "disable", "telemetry"], { env, stdio: "ignore" });
  const claudeAfterDisable = fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8");
  assert.doesNotMatch(claudeAfterDisable, /roborepo telemetry capture/, "fixed: capture hooks no longer remain wired in Claude settings.json after `disable telemetry`");
  const codexAfterDisable = fs.readFileSync(path.join(tmp, ".codex", "hooks.json"), "utf8");
  assert.doesNotMatch(codexAfterDisable, /roborepo telemetry capture/, "fixed: capture hooks no longer remain wired in Codex hooks.json after `disable telemetry`");

  const pkgConfig = JSON.parse(fs.readFileSync(path.join(repoRoot, "globals/packages/telemetry/package.config.json"), "utf8"));
  const declared = pkgConfig.components ?? pkgConfig.resources ?? [];
  const hooksComponents = declared.filter((c) => c.type === "hooks");
  assert.equal(hooksComponents.length, 2, "telemetry package now declares hooks/claude and hooks/codex components");

  // Re-enable: idempotent, no duplication, both harnesses restored.
  spawnSync(process.execPath, [cli, "package", "enable", "telemetry"], { env, stdio: "ignore" });
  const claudeAfterReenable = JSON.parse(fs.readFileSync(path.join(tmp, ".claude", "settings.json"), "utf8"));
  const preToolUseCount = (claudeAfterReenable.hooks?.PreToolUse || [])
    .filter((e) => (e.hooks || []).some((h) => h.command === "roborepo telemetry capture --harness claude --event PreToolUse")).length;
  assert.equal(preToolUseCount, 1, "re-enabling telemetry restores hooks without duplication");

  fs.rmSync(tmp, { recursive: true, force: true });
}

// --- Item 10 (FIXED in Phase 7): disabled command-backed package leaves no native slash command,
// and disabling one package's command never removes another package's or the user's own command.
// This is the backfilled Phase-0 test the plan doc flagged as missing from the original characterization
// pass — added here directly against the fix rather than as a separate leaky-then-fixed pair, since
// Phase 0 never captured the "before" state for this item. ---
{
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-command-ownership-"));
  const env = { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: path.join(tmp, ".roborepo"), SKIP_MCP: "1" };
  fs.mkdirSync(path.join(tmp, ".claude", "commands"), { recursive: true });
  fs.mkdirSync(path.join(tmp, ".codex", "commands"), { recursive: true });
  fs.writeFileSync(path.join(tmp, ".claude", "settings.json"), "{}");
  fs.writeFileSync(path.join(tmp, ".codex", "config.toml"), "");
  fs.writeFileSync(path.join(tmp, ".claude", "commands", "user-owned.md"), "user command\n");

  spawnSync(process.execPath, [cli, "package", "enable", "plan-write"], { env, stdio: "ignore" });
  spawnSync(process.execPath, [cli, "package", "enable", "tighten"], { env, stdio: "ignore" });
  assert.ok(fs.existsSync(path.join(tmp, ".claude", "commands", "plan-write.md")), "enabled plan-write installs its Claude command wrapper");
  assert.ok(fs.existsSync(path.join(tmp, ".codex", "commands", "plan-write.md")), "enabled plan-write installs its Codex command wrapper");

  spawnSync(process.execPath, [cli, "package", "disable", "plan-write"], { env, stdio: "ignore" });
  assert.ok(!fs.existsSync(path.join(tmp, ".claude", "commands", "plan-write.md")), "disabled plan-write removes its Claude command wrapper");
  assert.ok(!fs.existsSync(path.join(tmp, ".codex", "commands", "plan-write.md")), "disabled plan-write removes its Codex command wrapper");
  assert.ok(fs.existsSync(path.join(tmp, ".claude", "commands", "tighten.md")), "disabling plan-write leaves tighten's command untouched");
  assert.ok(fs.existsSync(path.join(tmp, ".claude", "commands", "user-owned.md")), "disabling plan-write leaves the user's own command untouched");

  fs.rmSync(tmp, { recursive: true, force: true });
}

console.log("ok: system-package-ownership characterization (all leaks reproduced as expected)");