#!/usr/bin/env node
// Core hook wiring has a source of truth, and the tracked artifact agrees with it.
//
// THE GAP THIS CLOSES: package hooks declare their wiring in a fragment
// (globals/packages/<id>/hooks-claude.json) that is merged in on enable, so the matcher and command
// have a reviewable source. The hooks roborepo always installs had no such fragment — they existed
// only in generated/claude/settings.json, which `renderClaudeSettings` preserves but does not
// produce. That made the matcher hand-maintained tracked state: editing it was invisible to review,
// and nothing detected a divergence between the fragment-less artifact and what was installed.
//
// The `Read|Write|Edit` matcher is the case that motivated this. It was widened from `Write|Edit`
// by hand, and no check anywhere would have caught it being silently reverted or mistyped.
//
// WHAT THIS ASSERTS, and what it deliberately does not:
//   - every core entry declared in the fragment appears in the tracked artifact, matcher included;
//   - the two hooks that must NOT share a matcher still do not (see below);
//   - it does NOT assert the artifact contains only these entries, because package hooks merge into
//     the same file and their presence depends on which packages are enabled.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");

const readJson = (rel) => JSON.parse(fs.readFileSync(path.join(repoRoot, rel), "utf8"));

const fragment = readJson("globals/harnesses/claude/hooks-claude.json");
const settings = readJson("generated/claude/settings.json");

// Identity is the literal command string, matching the merge logic in
// scripts/harnesses/hooks-merge.mjs — no package-ID tag is stored on the entry itself.
function findEntryByCommand(event, command) {
  for (const entry of settings.hooks?.[event] ?? []) {
    if ((entry.hooks ?? []).some((h) => h.command === command)) return entry;
  }
  return null;
}

// Source-only explanations and supported native labels are required for every shipped Codex hook.
const codexFragments = [readJson("globals/harnesses/codex/hooks-codex.json").hooks];
for (const root of ["globals/packages"]) {
  for (const entry of fs.readdirSync(path.join(repoRoot, root), { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const directory = path.join(repoRoot, root, entry.name);
    const manifestPath = path.join(directory, "package.config.json");
    if (!fs.existsSync(manifestPath)) continue;
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
    for (const resource of manifest.resources || []) {
      if (resource.type !== "hooks" || resource.harness !== "codex") continue;
      codexFragments.push(JSON.parse(fs.readFileSync(path.join(directory, resource.source), "utf8")));
    }
  }
}
for (const fragment of codexFragments) {
  const hooks = Object.entries(fragment).filter(([event]) => !event.startsWith("_"))
    .flatMap(([, groups]) => groups.flatMap((group) => group.hooks || []));
  const names = hooks.map((hook) => hook.statusMessage);
  assert.ok(names.every((name) => typeof name === "string" && name.startsWith("RoboRepo: ")), "every shipped Codex hook needs a readable RoboRepo native name");
  assert.equal(new Set(names).size, names.length, "native names identify individual hooks within a fragment");
  for (const name of names) assert.ok(fragment._descriptions?.[name]?.trim(), `${name} needs a contextual source description`);
  assert.deepEqual(Object.keys(fragment._descriptions).sort(), [...names].sort(), "descriptions must match the source hooks exactly");
}
assert.ok(!("_descriptions" in readJson("generated/codex/hooks.json").hooks), "source-only help is excluded from native output");

const problems = [];

for (const [event, entries] of Object.entries(fragment)) {
  if (event.startsWith("_")) continue; // `_comment` keys document the fragment, not wiring
  for (const declared of entries) {
    for (const hook of declared.hooks ?? []) {
      const found = findEntryByCommand(event, hook.command);
      if (!found) {
        problems.push(`${event}: no entry in generated/claude/settings.json runs ${hook.command}`);
        continue;
      }
      if (found.matcher !== declared.matcher) {
        problems.push(
          `${event}: ${hook.command}\n    fragment declares matcher ${JSON.stringify(declared.matcher)}`
            + `\n    artifact has        matcher ${JSON.stringify(found.matcher)}`,
        );
      }
    }
  }
}

assert.deepEqual(
  problems,
  [],
  `core hook wiring disagrees with its source fragment:\n${problems.join("\n")}`,
);

// --- Invariants the fragment alone cannot express -----------------------------------------------

const scopeHook = 'node "$HOME/.claude/hooks/provider/repo-write-scope.mjs"';
const guardHook = 'node "$HOME/.claude/hooks/write-guard.mjs"';

const scopeEntry = findEntryByCommand("PreToolUse", scopeHook);
const guardEntry = findEntryByCommand("PreToolUse", guardHook);

// The scope hook must cover Read. Reads are the whole reason the repository family exists; a
// matcher that lost `Read` would silently return the boundary to writes-only, with no test failing
// anywhere else — every repo-write-scope-check case would still pass, because it invokes the hook
// directly rather than through a matcher.
assert.ok(
  /(^|\|)Read(\||$)/.test(scopeEntry.matcher),
  `repo-write-scope must run on Read; matcher is ${JSON.stringify(scopeEntry.matcher)}`,
);

// The guard must NOT cover Read. It emits symlink reminders about writes and has nothing to say
// about a read, so a Read in its matcher is a process spawn per read for no output.
assert.ok(
  !/(^|\|)Read(\||$)/.test(guardEntry.matcher),
  `write-guard must not run on Read; matcher is ${JSON.stringify(guardEntry.matcher)}`,
);

// Every hook script the fragment points at must exist in the repo. `$HOME/.claude/hooks/...` is the
// installed location; the sources are split by the platform/provider seam, so both roots are
// searched rather than assuming one.
for (const [event, entries] of Object.entries(fragment)) {
  if (event.startsWith("_")) continue;
  for (const declared of entries) {
    for (const hook of declared.hooks ?? []) {
      const match = /\$HOME\/\.claude\/hooks\/(?:provider\/)?([\w.-]+\.mjs)/.exec(hook.command);
      if (!match) continue;
      const name = match[1];
      const candidates = [
        path.join(repoRoot, "globals/harnesses/claude/hooks", name),
        path.join(repoRoot, "globals/system/hooks/claude", name),
      ];
      assert.ok(
        candidates.some((p) => fs.existsSync(p)),
        `${event}: ${name} is wired but exists in neither the provider nor the platform hooks dir`,
      );
    }
  }
}

console.log("core-hook-wiring ok");
