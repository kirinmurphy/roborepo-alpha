#!/usr/bin/env node
// Package config patches: the JSON and TOML config editors providers expose, and the set/union
// semantics a package's config-patch resource gets from scripts/cli/package-config-patches.mjs —
// conflict preservation, provenance restore, removing only the package's own items, package-runtime
// path expansion, the enable/disable/enable round trip, status probes, and validation errors.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-patches-"));
process.on("exit", () => fs.rmSync(tmp, { recursive: true, force: true }));
process.env.HOME = tmp;
process.env.ROBOREPO_STATE_ROOT = path.join(tmp, ".roborepo");

const { jsonConfigEdit } = await import("../harnesses/config-edit/json.mjs");
const { tomlConfigEdit } = await import("../harnesses/config-edit/toml.mjs");
const { applyConfigPatches, removeConfigPatches, probeConfigPatches, normalizeConfigPatches } = await import("../cli/package-config-patches.mjs");
const { packageRuntimeAssetDestination } = await import("../cli/package-runtime-assets.mjs");

const quiet = () => {};
let fileCount = 0;
function sandbox(name, content = "") {
  const configPath = path.join(tmp, `${(fileCount += 1)}-${name}`);
  if (content) fs.writeFileSync(configPath, content);
  return {
    configPath,
    read: () => (fs.existsSync(configPath) ? fs.readFileSync(configPath, "utf8") : ""),
    options: { configPath, write: (text) => fs.writeFileSync(configPath, text), log: quiet },
  };
}
const json = (text) => JSON.parse(text || "{}");
const pkg = { id: "patch-pkg", components: [] };
const component = (harness, patches) => ({ type: "config-patch", harness, label: "test setting", patches });

// --- editors --------------------------------------------------------------------------------

{
  const source = [
    "model = \"gpt\"  # keep",
    "",
    "[tui]",
    "# user comment",
    "status_line = [",
    "  \"a\", # first",
    "  \"b\",",
    "]",
    "",
    "[mcp_servers.\"x.y\"]",
    "command = 'z'",
    "",
  ].join("\n");
  assert.deepEqual(tomlConfigEdit.get(source, ["tui", "status_line"]), { found: true, value: ["a", "b"] }, "reads a multi-line array with comments");
  assert.deepEqual(tomlConfigEdit.get(source, ["mcp_servers", "x.y", "command"]), { found: true, value: "z" }, "reads under a quoted table key");
  assert.deepEqual(tomlConfigEdit.get(source, ["tui", "missing"]), { found: false, value: undefined });

  let next = tomlConfigEdit.set(source, ["tui", "status_line"], ["a", "b", "c"]);
  next = tomlConfigEdit.set(next, ["mcp_servers", "fx", "tools", "lookup", "approval_mode"], "approve");
  assert.match(next, /# user comment\nstatus_line = \["a", "b", "c"\]\n/, "replaces the value and keeps the comment above it");
  assert.match(next, /model = "gpt" {2}# keep/, "leaves unrelated lines byte-for-byte");
  assert.match(next, /\n\[mcp_servers\.fx\.tools\.lookup\]\napproval_mode = "approve"\n$/, "appends a new table");

  const removed = tomlConfigEdit.delete(next, ["mcp_servers", "fx", "tools", "lookup", "approval_mode"]);
  assert.equal(removed, tomlConfigEdit.set(source, ["tui", "status_line"], ["a", "b", "c"]), "removing the only key drops the table it created");
  assert.throws(() => tomlConfigEdit.set("", ["x"], null), /TOML cannot hold null/);
}

{
  let text = jsonConfigEdit.set("", ["env", "A"], "1");
  text = jsonConfigEdit.set(text, ["enabledPlugins", "caveman@caveman"], true);
  assert.deepEqual(json(text), { env: { A: "1" }, enabledPlugins: { "caveman@caveman": true } }, "keys are path items, so @ and . need no escaping");
  text = jsonConfigEdit.delete(text, ["env", "A"]);
  assert.deepEqual(json(text), { enabledPlugins: { "caveman@caveman": true } }, "delete prunes a parent it emptied");
  assert.throws(() => jsonConfigEdit.set("{\"env\": 1}", ["env", "A"], "1"), /env is not an object/);
}

// --- set: Claude statusLine ----------------------------------------------------------------

const statusLine = { type: "command", command: "node status.mjs", padding: 1 };
const setStatus = component("claude", [{ op: "set", path: ["statusLine"], value: statusLine }]);

{
  const box = sandbox("settings.json", "{\n  \"model\": \"opus\"\n}\n");
  applyConfigPatches(pkg, setStatus, box.options);
  assert.deepEqual(json(box.read()).statusLine, statusLine, "set writes an absent key");
  assert.equal(probeConfigPatches(pkg, setStatus, box.options).observed, true);
  removeConfigPatches(pkg, setStatus, box.options);
  assert.deepEqual(json(box.read()), { model: "opus" }, "remove takes out a key roborepo introduced");
}

{
  const user = { type: "command", command: "my-own" };
  const box = sandbox("settings.json", `${JSON.stringify({ statusLine: user })}\n`);
  const before = box.read();
  applyConfigPatches(pkg, setStatus, box.options);
  assert.equal(box.read(), before, "an unmanaged different value is left alone");
  const probe = probeConfigPatches(pkg, setStatus, box.options);
  assert.equal(probe.observed, false);
  assert.equal(probe.owner, "external");
  removeConfigPatches(pkg, setStatus, box.options);
  assert.equal(box.read(), before, "remove never deletes a value roborepo did not set");
}

{
  // A value written before provenance was recorded, equal to ours, still comes out on removal.
  const box = sandbox("settings.json", `${JSON.stringify({ statusLine })}\n`);
  applyConfigPatches(pkg, setStatus, box.options);
  removeConfigPatches(pkg, setStatus, box.options);
  assert.equal(json(box.read()).statusLine, undefined);
}

// --- set with provenance: Codex scalar ------------------------------------------------------

{
  const colors = component("codex", [{ op: "set", path: ["tui", "status_line_use_colors"], value: true }]);
  const box = sandbox("config.toml", "[tui]\nanimations = false\n");
  applyConfigPatches(pkg, colors, box.options);
  applyConfigPatches(pkg, colors, box.options);
  assert.match(box.read(), /^status_line_use_colors = true$/m);
  // The user flips it after enable: removal leaves their value and forgets ownership.
  fs.writeFileSync(box.configPath, box.read().replace("= true", "= false"));
  removeConfigPatches(pkg, colors, box.options);
  assert.match(box.read(), /^status_line_use_colors = false$/m, "a value changed after enable is the user's");
  removeConfigPatches(pkg, colors, box.options);
  assert.match(box.read(), /^status_line_use_colors = false$/m);
}

// --- union: Codex status_line, Claude plugin-dir list ---------------------------------------

{
  const items = component("codex", [{ op: "union", path: ["tui", "status_line"], value: ["model", "five-hour-limit"] }]);
  const box = sandbox("config.toml", "# top\n[tui]\nstatus_line = [\"git-branch\", \"model\"]\n");
  applyConfigPatches(pkg, items, box.options);
  assert.deepEqual(tomlConfigEdit.get(box.read(), ["tui", "status_line"]).value, ["git-branch", "model", "five-hour-limit"], "union appends only missing items");
  removeConfigPatches(pkg, items, box.options);
  assert.deepEqual(tomlConfigEdit.get(box.read(), ["tui", "status_line"]).value, ["git-branch"], "union removes only the package's items");

  const fresh = sandbox("config.toml");
  applyConfigPatches(pkg, items, fresh.options);
  const firstEnable = fresh.read();
  assert.equal(firstEnable, "[tui]\nstatus_line = [\"model\", \"five-hour-limit\"]\n");
  removeConfigPatches(pkg, items, fresh.options);
  assert.equal(fresh.read(), "", "emptying the list removes the key and the table roborepo created");
  applyConfigPatches(pkg, items, fresh.options);
  assert.equal(fresh.read(), firstEnable, "enable/disable/enable round-trips byte-for-byte");
}

{
  const assetPkg = { id: "dir-pkg", components: [{ type: "package-runtime-asset", source: "globals/packages/dir-pkg/plugin" }] };
  const installed = packageRuntimeAssetDestination(assetPkg, assetPkg.components[0]);
  const dirs = component("claude", [{ op: "union", path: ["env", "PLUGIN_DIRS"], value: ["${package-runtime:plugin}"], delimiter: "path" }]);
  const box = sandbox("settings.json", `${JSON.stringify({ env: { PLUGIN_DIRS: "/elsewhere" } })}\n`);
  applyConfigPatches(assetPkg, dirs, box.options);
  assert.equal(json(box.read()).env.PLUGIN_DIRS, ["/elsewhere", installed].join(path.delimiter), "expands the package-runtime path and joins with the OS separator");
  assert.equal(probeConfigPatches(assetPkg, dirs, box.options).observed, true);
  removeConfigPatches(assetPkg, dirs, box.options);
  assert.equal(json(box.read()).env.PLUGIN_DIRS, "/elsewhere");

  const alone = sandbox("settings.json");
  applyConfigPatches(assetPkg, dirs, alone.options);
  removeConfigPatches(assetPkg, dirs, alone.options);
  assert.deepEqual(json(alone.read()), {}, "the last item out removes the variable and the empty env");
}

// --- validation -----------------------------------------------------------------------------

{
  const label = "pkg:config-patch";
  assert.throws(() => normalizeConfigPatches([], "claude", label), /non-empty patches array/);
  assert.throws(() => normalizeConfigPatches([{ op: "merge", path: ["a"], value: 1 }], "claude", label), /op must be one of set, union/);
  assert.throws(() => normalizeConfigPatches([{ op: "set", path: "a", value: 1 }], "claude", label), /path must be a non-empty array/);
  assert.throws(() => normalizeConfigPatches([{ op: "set", path: ["a"] }], "claude", label), /set needs a value/);
  assert.throws(() => normalizeConfigPatches([{ op: "union", path: ["a"], value: [1] }], "claude", label), /non-empty array of strings/);
  assert.throws(() => normalizeConfigPatches([{ op: "set", path: ["a"], value: 1, delimiter: "," }], "claude", label), /delimiter only applies to union/);
  assert.throws(() => normalizeConfigPatches([{ op: "set", path: ["a"], value: null }], "codex", label), /TOML cannot hold null/);
  assert.throws(() => normalizeConfigPatches([{ op: "set", path: ["a"], value: 1 }], "no-such-harness", label));
}

console.log("ok: package config patches");
