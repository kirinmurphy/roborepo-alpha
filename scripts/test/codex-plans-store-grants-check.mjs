#!/usr/bin/env node
// Pins what a Codex profile adds for a repository's plans store: its worktree root and the exact Git
// paths a store commit and fetch write, with hooks, config, and other branches left out. The grant
// itself was measured against `codex exec`; this check pins the rendered list, not native enforcement.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";

const fixture = createPlanFixture("roborepo-codex-store-grants-");
const home = path.join(fixture.tmp, "home");
process.env.ROBOREPO_STATE_ROOT = path.join(home, ".roborepo");
const { loadPermissionManifest, renderPermissionsTo } = await import("../cli/permissions-render.mjs");
const { getHarnessProvider } = await import("../harnesses/registry.mjs");

const codex = getHarnessProvider("codex");
const { CODEX_SANDBOX_WRITABLE_PATHS } = await import("../harnesses/codex/index.mjs");
// Grants beyond the provider's fixed ones (the agent scratch folder), which every profile carries.
const storeGrants = (toml) => [...toml.matchAll(/^"(.+)" = "write"$/gm)].map((match) => match[1])
  .filter((grant) => !CODEX_SANDBOX_WRITABLE_PATHS.includes(grant));
const configFile = path.join(home, ".codex", "config.toml");
fs.writeFileSync(configFile, "");
const render = (cwd, overrides = {}) => {
  renderPermissionsTo(home, { manifest: loadPermissionManifest(), overrides, cwd });
  return fs.readFileSync(configFile, "utf8");
};

try {
  const repo = fixture.repository("sample-repo");
  const common = fs.realpathSync(path.join(repo, ".git"));
  const toml = render(repo);

  // ---------------------------------------------------------------- roots
  const root = path.join(fixture.tmp, "worktree-root", "sample-repo");
  assert.deepEqual(codex.adapters.permissions.workspaceRoots({ cwd: repo }), [root]);
  assert.ok(toml.includes(`[permissions.managed-workspace.workspace_roots]\n${JSON.stringify(root)} = true`));

  // ---------------------------------------------------------------- exact grants
  assert.ok(toml.includes('"~/.roborepo/scratch/**" = "write"'), "every workspace profile grants the scratch folder");
  const grants = storeGrants(toml);
  assert.deepEqual(grants, [
    path.join(common, "objects/**"),
    path.join(common, "worktrees/repo_plans/**"),
    path.join(common, "refs/heads/repo-plans"),
    path.join(common, "refs/heads/repo-plans.lock"),
    path.join(common, "logs/refs/heads/repo-plans"),
    path.join(common, "logs/refs/heads/repo-plans.lock"),
    path.join(common, "refs/remotes/origin/repo-plans"),
    path.join(common, "refs/remotes/origin/repo-plans.lock"),
    path.join(common, "logs/refs/remotes/origin/repo-plans"),
    path.join(common, "logs/refs/remotes/origin/repo-plans.lock"),
  ]);
  for (const forbidden of ["hooks", "config", "packed-refs", "refs/heads/main"]) {
    assert.ok(!grants.some((grant) => grant === path.join(common, forbidden) || grant.startsWith(`${path.join(common, forbidden)}/`)), `${forbidden} must stay denied`);
  }

  // ---------------------------------------------------------------- same answer from a linked worktree
  const linked = path.join(fixture.tmp, "linked");
  fixture.git(repo, "worktree", "add", "--quiet", "-b", "feature", linked);
  assert.equal(render(linked), toml, "a linked worktree resolves the same repository");

  // ---------------------------------------------------------------- none when there is nothing to grant
  const readOnly = render(repo, { behaviors: { "write-files": "ask" } });
  assert.doesNotMatch(readOnly, /= "write"/, "a read-only profile grants no writes");
  const unset = render(fixture.repository("no-store", {}, { store: false }));
  assert.deepEqual(storeGrants(unset), [], "a repository with no store adds no grant");
  assert.doesNotMatch(unset, /workspace_roots/, "a repository with no store adds no root");
  const outside = fs.mkdtempSync(path.join(fixture.tmp, "outside-"));
  const outsideToml = render(outside);
  assert.deepEqual(storeGrants(outsideToml), [], "outside a repository adds no grant");
  assert.doesNotMatch(outsideToml, /workspace_roots/, "outside a repository adds no root");

  // ---------------------------------------------------------------- reserved worktree as the cwd
  assert.deepEqual(
    codex.adapters.permissions.writablePaths({ cwd: fixture.storePath(repo) }),
    codex.adapters.permissions.writablePaths({ cwd: repo }),
  );
  console.log("ok: codex plans store grants");
} finally {
  fixture.cleanup();
}
