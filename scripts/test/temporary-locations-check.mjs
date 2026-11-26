#!/usr/bin/env node
// Holds every consumer of the manifest's temporaryLocations to that one list, and every entry to a
// cleanup.
//
// temporaryLocations names the folders agents use for temporary files. Reading, writing, editing,
// and deleting there never needs a prompt, so each entry must also name what removes old files, or
// an agent could fill it forever unseen. The list is read by the Claude read/write scopes, both shell
// sandboxes, the repository-boundary hook, and the delete guard; this check fails when any of them
// stops covering an entry, and when a retention-store entry disagrees with the retention registry.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { resolveBehaviors, temporaryLocationGlobs } from "../harnesses/permissions-render.mjs";
import { codexSandboxWritablePaths } from "../harnesses/codex/index.mjs";
import { FOLDER_SET_SHAPE, retentionStores } from "../../modules/retention/index.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests/inventory/agent-permissions.json"), "utf8"));
const locations = manifest.temporaryLocations;

// --- Every entry is well formed and cleaned up. ---
assert.ok(Array.isArray(locations) && locations.length > 0, "temporaryLocations is declared");
const home = path.join(os.tmpdir(), "roborepo-temporary-locations-home");
const stores = retentionStores(path.join(home, ".roborepo"), { home });
for (const location of locations) {
  assert.ok(location.id && location.label, "every location has an id and a label");
  assert.ok(location.paths?.length, `${location.id} lists folders`);
  assert.ok(location.harnesses?.every((h) => ["claude", "codex"].includes(h)), `${location.id} names known harnesses`);
  for (const folder of location.paths) {
    assert.ok(folder.startsWith("/") || folder.startsWith("~/"), `${folder} is absolute or ~/-anchored`);
    assert.ok(!folder.endsWith("/") && !folder.includes("*"), `${folder} is a plain folder, not a glob`);
  }
  const { cleanup } = location;
  if (cleanup?.by === "os") {
    assert.ok(cleanup.description, `${location.id} says which OS mechanism cleans it`);
    assert.ok(location.paths.every((folder) => folder.startsWith("/")), `${location.id}: only system folders are OS-cleaned`);
  } else {
    assert.equal(cleanup?.by, "retention-store", `${location.id} names a cleanup`);
    const store = stores.find((candidate) => candidate.id === cleanup.store);
    assert.ok(store, `${location.id}: retention store ${cleanup.store} is registered`);
    assert.equal(store.shape, FOLDER_SET_SHAPE, `${store.id} is pruned per folder`);
    assert.ok(store.policy.maxAgeDays, `${store.id} removes folders by age`);
    const expanded = location.paths.map((folder) => (folder.startsWith("~/") ? path.join(home, folder.slice(2)) : folder));
    assert.deepEqual(expanded, [store.target], `${location.id} and retention store ${store.id} name the same folder`);
  }
}

// --- Claude: the read and write scopes, the rendered rules, and the shell sandbox. ---
const claudeGlobs = temporaryLocationGlobs(manifest, "claude");
const behaviors = resolveBehaviors(manifest);
for (const id of ["read-scope", "write-scope"]) {
  assert.deepEqual(behaviors.find((b) => b.id === id).paths, claudeGlobs, `${id} covers exactly the temporary locations`);
}
const settings = JSON.parse(getHarnessProvider("claude").adapters.permissions.render("{}", manifest, {}, "settings.json", {}));
const ruleFor = (tool, glob) => (glob.startsWith("~/") ? `${tool}(${glob})` : `${tool}(//${glob.replace(/^\/+/, "")})`);
for (const glob of claudeGlobs) {
  // Claude's docs say Edit rules decide writes; Write is rendered beside it for older readers.
  for (const tool of ["Read", "Edit", "Write"]) assert.ok(settings.permissions.allow.includes(ruleFor(tool, glob)), `allow ${ruleFor(tool, glob)}`);
  if (glob.startsWith("~/")) {
    assert.ok(settings.sandbox.filesystem.allowWrite.includes(glob.replace(/\/\*\*$/, "")), `the Claude sandbox writes ${glob}`);
  }
}
const generated = JSON.parse(fs.readFileSync(path.join(repoRoot, "generated/claude/settings.json"), "utf8"));
assert.deepEqual(generated.sandbox.filesystem.allowWrite, settings.sandbox.filesystem.allowWrite, "generated Claude sandbox is current");

// --- Codex: its workspace profile grants system temp itself; the home-folder entries are rendered. ---
const codexHome = temporaryLocationGlobs(manifest, "codex").filter((glob) => glob.startsWith("~/"));
assert.deepEqual(codexSandboxWritablePaths(manifest), codexHome);
const codexConfig = fs.readFileSync(path.join(repoRoot, "generated/codex/config.toml"), "utf8");
for (const glob of codexHome) assert.ok(codexConfig.includes(`"${glob}" = "write"`), `Codex config writes ${glob}`);
assert.ok(!codexConfig.includes("side-session-notes"), "the Claude app's notes folder is not granted to Codex");

// --- The session-start prune removes stale notes folders and keeps recent ones. ---
const fakeHome = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-notes-prune-"));
try {
  const notes = path.join(fakeHome, "Library", "Application Support", "Claude", "side-session-notes");
  const stale = path.join(notes, "local_stale");
  const fresh = path.join(notes, "local_fresh");
  const newest = path.join(notes, "local_newest");
  for (const dir of [stale, fresh, newest]) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, "notes.md"), "x");
  }
  const daysAgo = (n) => new Date(Date.now() - n * 24 * 60 * 60 * 1000);
  for (const [dir, days] of [[stale, 20], [fresh, 3], [newest, 0]]) {
    fs.utimesSync(path.join(dir, "notes.md"), daysAgo(days), daysAgo(days));
    fs.utimesSync(dir, daysAgo(days), daysAgo(days));
  }
  const result = spawnSync(process.execPath, [path.join(repoRoot, "globals/system/hooks/claude/prune-side-session-notes.mjs")], {
    input: "{}",
    encoding: "utf8",
    env: { ...process.env, HOME: fakeHome, REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: path.join(fakeHome, ".roborepo") },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "", "the prune hook prints nothing on stdout");
  assert.ok(!fs.existsSync(stale), "a notes folder unchanged for 20 days is removed");
  assert.ok(fs.existsSync(fresh) && fs.existsSync(newest), "recent notes folders are kept");

  // No notes folder at all (Linux, or no side sessions yet) is a quiet no-op.
  fs.rmSync(notes, { recursive: true, force: true });
  const absent = spawnSync(process.execPath, [path.join(repoRoot, "globals/system/hooks/claude/prune-side-session-notes.mjs")], {
    input: "{}", encoding: "utf8", env: { ...process.env, HOME: fakeHome, REPO_ROOT: repoRoot },
  });
  assert.equal(absent.status, 0);
  assert.equal(absent.stdout + absent.stderr, "");
} finally {
  fs.rmSync(fakeHome, { recursive: true, force: true });
}

console.log(`temporary-locations-check passed (${locations.length} locations)`);
