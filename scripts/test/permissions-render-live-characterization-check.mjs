#!/usr/bin/env node
// Characterizes permissions-render.mjs's renderPermissionsTo (the LIVE home-config path used by
// config controls, distinct from scripts/build/render-agent-permissions.mjs's build-time repo
// SOURCE render, which is out of scope here and already covered by doctor's real
// `render-agent-permissions.mjs --check` run). Dispatches through each present harness's own
// permissions.render adapter. Pins: only present harness config gets written, Codex is skipped when its config.toml
// doesn't already exist (never fabricated from nothing), Claude's model key is always stripped,
// Gemini's Policy Engine file is written whenever ~/.gemini/ is present (Gemini fully owns that
// file, so — unlike Codex — there's no "don't fabricate" gate), and every harness's generated
// output reflects the same resolved behaviors/overrides.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ROBOREPO_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const {
  loadPermissionManifest,
  loadPermissionWorkspaceRoots,
  loadPermissionWorkspaceRootsForCwd,
  renderPermissionsTo,
} = await import("../cli/permissions-render.mjs");

const manifest = loadPermissionManifest();

function makeHome() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "permissions-live-"));
}

// --- Plans config worktreeRoot materializes a concrete Codex workspace root per repo family ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-config-root-"));
  try {
    const project = path.join(root, "sample-repo");
    const plansDir = path.join(project, "docs", "plans");
    const configPath = path.join(plansDir, "plans-config.json");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, worktreeRoot: "~/.worktrees" }));
    assert.deepEqual(
      loadPermissionWorkspaceRoots({ configPath }),
      ["~/.worktrees/sample-repo"],
      "a normal checkout derives ~/.worktrees/<repo-folder-name> from plans-config worktreeRoot",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- The same derivation works when cwd is already inside ~/.worktrees/<repo>/<branch> ---
{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-worktree-home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = home;
  try {
    const project = path.join(home, ".worktrees", "sample-repo", "feature-branch");
    const plansDir = path.join(project, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "plans-config.json"), JSON.stringify({ schemaVersion: 1, worktreeRoot: "~/.worktrees" }));
    assert.deepEqual(
      loadPermissionWorkspaceRootsForCwd(path.join(project, "src")),
      ["~/.worktrees/sample-repo"],
      "a nested worktree checkout derives the shared repo-family root, not the branch folder",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- An explicit worktreeRepoName keeps package-mode app folder names out of workspace roots ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-app-root-"));
  try {
    const project = path.join(root, "codethings-roborepo-alpha");
    const plansDir = path.join(project, "docs", "plans");
    const configPath = path.join(plansDir, "plans-config.json");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, worktreeRoot: "~/.worktrees", worktreeRepoName: "roborepo" }));
    assert.deepEqual(
      loadPermissionWorkspaceRoots({ configPath }),
      ["~/.worktrees/roborepo"],
      "explicit worktreeRepoName avoids deriving the npm package folder as the repo-family root",
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

// --- Derivation is stable when tests replace HOME with a synthetic install home ---
{
  const realHome = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-real-home-"));
  const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-fake-home-"));
  const oldHome = process.env.HOME;
  process.env.HOME = fakeHome;
  try {
    const project = path.join(realHome, ".worktrees", "sample-repo", "feature-branch");
    const plansDir = path.join(project, "docs", "plans");
    const configPath = path.join(plansDir, "plans-config.json");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(configPath, JSON.stringify({ schemaVersion: 1, worktreeRoot: "~/.worktrees" }));
    assert.deepEqual(
      loadPermissionWorkspaceRoots({ configPath }),
      ["~/.worktrees/sample-repo"],
      "a synthetic HOME must not make generated workspace roots fall back to the branch folder",
    );
  } finally {
    if (oldHome === undefined) delete process.env.HOME;
    else process.env.HOME = oldHome;
    fs.rmSync(realHome, { recursive: true, force: true });
    fs.rmSync(fakeHome, { recursive: true, force: true });
  }
}

// --- Only present harness configs are touched; Codex is skipped entirely when config.toml doesn't
// already exist (a home with only .claude present) ---
{
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    const { touched } = renderPermissionsTo(home, { manifest });
    assert.deepEqual(touched, [path.join(home, ".claude", "settings.json")], "only the present Claude settings file is touched");
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.ok(settings.permissions, "permissions key rendered into Claude settings");
    assert.ok(Array.isArray(settings.permissions.allow), "Claude permissions.allow is an array");
    assert.ok(
      settings.hooks?.PreToolUse?.some((entry) =>
        entry.matcher === "Read|Write|Edit"
          && entry.hooks?.some((hook) => hook.command === 'node "$HOME/.claude/hooks/provider/repo-write-scope.mjs"')),
      "core Claude repo-scope hook is rendered from globals/harnesses/claude/hooks-claude.json",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Live Codex render adds the current repo family's worktree root through the provider adapter ---
{
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-live-repo-root-"));
  const home = makeHome();
  try {
    const project = path.join(root, "sample-repo");
    const plansDir = path.join(project, "docs", "plans");
    fs.mkdirSync(plansDir, { recursive: true });
    fs.writeFileSync(path.join(plansDir, "plans-config.json"), JSON.stringify({ schemaVersion: 1, worktreeRoot: "~/.worktrees" }));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
    renderPermissionsTo(home, { manifest, cwd: path.join(project, "src") });
    const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /"~\/\.worktrees\/sample-repo" = true/, "Codex provider contributes the current repo family's worktree root");
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- All three present, both existing rootConfigs: all three get touched, model key stripped
// from Claude ---
{
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({ model: "some-model", other: "kept" }));
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), "model_reasoning_effort = \"high\"\n");
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    const { touched } = renderPermissionsTo(home, { manifest });
    assert.equal(touched.length, 3, "all three present harness targets are touched");

    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    assert.equal(settings.model, undefined, "model key is always stripped from Claude settings");
    assert.equal(settings.other, "kept", "unrelated existing Claude settings keys are preserved");

    const codexToml = fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8");
    assert.match(codexToml, /BEGIN GENERATED AGENT PERMISSIONS/, "Codex config gets the generated permissions block");
    assert.match(codexToml, /default_permissions = "managed-workspace"/, "Codex uses a named permission profile");
    assert.match(codexToml, /\[permissions\.managed-workspace\.workspace_roots\]/, "Codex profile has workspace roots");
    assert.match(codexToml, /"~\/\.worktrees\/roborepo" = true/, "Codex profile includes this repo's plans-config worktree root");
    assert.doesNotMatch(codexToml, /^sandbox_mode =/m, "Codex profile render must not emit legacy sandbox_mode");
    assert.match(codexToml, /model_reasoning_effort = "high"/, "unrelated existing Codex config content is preserved");

    const geminiPolicyPath = path.join(home, ".gemini", "policies", "generated-permissions.toml");
    assert.ok(fs.existsSync(geminiPolicyPath), "Gemini's Policy Engine file is created when ~/.gemini/ is present");
    assert.match(fs.readFileSync(geminiPolicyPath, "utf8"), /^# Generated by roborepo/, "Gemini policy file starts with roborepo's own header");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Gemini home present but no policies/ subdirectory yet: created fresh, no "don't fabricate"
// gate like Codex's (roborepo fully owns this file, unlike Codex's shared config.toml) ---
{
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    const { touched } = renderPermissionsTo(home, { manifest });
    const geminiPolicyPath = path.join(home, ".gemini", "policies", "generated-permissions.toml");
    assert.deepEqual(touched, [geminiPolicyPath], "only the present Gemini policy target is touched");
    assert.ok(fs.existsSync(geminiPolicyPath), "policies/ subdirectory and file are created from nothing");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Codex home present but config.toml absent: never fabricated from nothing ---
{
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    // No config.toml written.
    renderPermissionsTo(home, { manifest });
    assert.equal(fs.existsSync(path.join(home, ".codex", "config.toml")), false, "Codex config.toml must never be fabricated when absent");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

// --- Overrides change the resolved bucket for every present harness consistently ---
{
  const home = makeHome();
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    const writeFilesBehavior = manifest.behaviors.find((b) => b.id === "write-files");
    assert.ok(writeFilesBehavior, "fixture assumption: manifest declares a write-files behavior");
    const overrides = { behaviors: { "write-files": "deny" } };
    renderPermissionsTo(home, { manifest, overrides });
    const settings = JSON.parse(fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"));
    const writeTools = writeFilesBehavior.tools || [];
    for (const tool of writeTools) {
      assert.ok(!settings.permissions.allow.includes(tool), `${tool} must not be in allow when write-files is overridden to deny`);
    }

    const geminiPolicy = fs.readFileSync(path.join(home, ".gemini", "policies", "generated-permissions.toml"), "utf8");
    assert.match(geminiPolicy, /toolName = \["write_file", "replace"\]\ndecision = "deny"/, "Gemini's write_file/replace rule reflects the same override, resolved independently through its own adapter");
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("permissions-render-live-characterization-check: ok");
