#!/usr/bin/env node
// renderCodexConfig regenerates the managed permissions block in ~/.codex/config.toml. The block
// sits where TOML top-level keys end, so another tool can add a setting inside it — Codex did this
// with the user's `notify` hook, and replacing the block wholesale deleted it. Lines the block did
// not generate must survive every render: top-level ones move above the block, tables below it.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { renderCodexConfig, resolveArbitraryCommands, resolveBehaviors } from "../harnesses/permissions-render.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests", "inventory", "agent-permissions.json"), "utf8"));
const behaviors = resolveBehaviors(manifest);
const commands = resolveArbitraryCommands(manifest);
const render = (text) => renderCodexConfig(text, behaviors, commands, "config.toml", { workspaceRoots: ["/work/root"] });

const between = (text) => text.slice(text.indexOf("# BEGIN GENERATED AGENT PERMISSIONS"), text.indexOf("# END GENERATED AGENT PERMISSIONS"));
const before = (text) => text.slice(0, text.indexOf("# BEGIN GENERATED AGENT PERMISSIONS"));
const after = (text) => text.slice(text.indexOf("# END GENERATED AGENT PERMISSIONS"));

// The layout found in a real config: Codex put `notify` after roborepo's top-level keys, inside the
// block, ahead of the block's first table.
const realLayout = `model = "gpt-6-sol"
model_reasoning_effort = "high"
# BEGIN GENERATED AGENT PERMISSIONS
# Source: manifests/inventory/agent-permissions.json
approval_policy = "on-request"
default_permissions = "managed-workspace"

notify = ["/Applications/Example.app/Contents/MacOS/client", "turn-ended"]

[permissions.managed-workspace]
extends = ":workspace"

[permissions.managed-workspace.network]
enabled = false
# END GENERATED AGENT PERMISSIONS

[tui]
status_line = ["model-with-reasoning"]
`;

const rendered = render(realLayout);
assert.match(before(rendered), /^notify = \["\/Applications\/Example\.app\/Contents\/MacOS\/client", "turn-ended"\]$/m,
  "a foreign top-level key inside the block moves above it");
assert.doesNotMatch(between(rendered), /notify/, "the regenerated block holds only roborepo's lines");
assert.equal((rendered.match(/^notify =/gm) || []).length, 1, "the foreign key is kept exactly once");
assert.equal((rendered.match(/^approval_policy =/gm) || []).length, 1, "roborepo's own keys are regenerated, not duplicated");
assert.match(after(rendered), /\[tui\]\nstatus_line/, "content after the block is untouched");
assert.equal(render(rendered), rendered, "rendering again changes nothing");

// A multi-line foreign value moves whole; a foreign table inside the block moves below it; a
// comment above a foreign key travels with it.
const mixed = `model = "x"
# BEGIN GENERATED AGENT PERMISSIONS
approval_policy = "never"
# keep me
hooks_dirs = [
  "/a",
  "/b # not a comment",
]
default_permissions = ":read-only"

[notice.model_migrations]
"old" = "new"

[permissions.managed-workspace]
extends = ":workspace"
# END GENERATED AGENT PERMISSIONS
`;
const mixedOut = render(mixed);
assert.match(before(mixedOut), /# keep me\nhooks_dirs = \[\n  "\/a",\n  "\/b # not a comment",\n\]\n/,
  "a multi-line array and its comment move above the block intact");
assert.match(after(mixedOut), /\[notice\.model_migrations\]\n"old" = "new"/, "a foreign table moves below the block");
assert.doesNotMatch(between(mixedOut), /notice|hooks_dirs|keep me/, "nothing foreign is left inside the block");
assert.equal(render(mixedOut), mixedOut, "the mixed case is stable on a second render");

// A block with nothing foreign renders exactly as before this change.
const clean = render(`model = "x"\n${between(rendered)}# END GENERATED AGENT PERMISSIONS\n`);
assert.equal(before(clean), 'model = "x"\n', "a clean block gains nothing above it");

console.log("codex-permissions-foreign-lines ok");
