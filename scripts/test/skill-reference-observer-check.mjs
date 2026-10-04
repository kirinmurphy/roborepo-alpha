#!/usr/bin/env node
// Phase 9/10 of docs/plans/active/agent-config-skill-reference-compliance.md: pins the behavior
// of the skill-visibility PostToolUse hooks that inject observed reference reads into a turn.
//
// The hook is a pure stdin -> stdout function, so every case here is deterministic and needs no
// harness. What it cannot cover is whether injected context survives to the end of a long turn —
// that assertion requires a live model in a real session and is verified by the manual probe
// documented in docs/internal/skill-reference-observation.md.
//
// The literal-path case is the one worth reading twice. Agents open references through
// ~/.claude/skills/..., a symlink into ~/.roborepo/skills/... Resolving that symlink would report a
// path the agent never read, and would silently match nothing. A test that only checked the happy
// path would pass against a hook that had quietly become useless.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const claudeHook = path.join(repoRoot, "globals/packages/skill-visibility/hooks/claude/skill-reference-observer.mjs");
const codexHook = path.join(repoRoot, "globals/packages/skill-visibility/hooks/codex/skill-reference-observer.mjs");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-observer-home-"));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-observer-state-"));

// Runs the hook with an isolated HOME and state root so the check never reads the developer's real
// skills directory and never writes a counter into their real state.
function runHook(hook, payload, { sessionId = "test-session" } = {}) {
  const input = { session_id: sessionId, ...payload };
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify(input),
    encoding: "utf8",
    env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot },
  });
  assert.equal(result.status, 0, `the hook must always exit 0; got ${result.status} (${result.stderr})`);
  return result.stdout.trim();
}

function observedReference(stdout) {
  if (!stdout) return null;
  const parsed = JSON.parse(stdout);
  assert.equal(parsed.hookSpecificOutput.hookEventName, "PostToolUse");
  return parsed.hookSpecificOutput.additionalContext;
}

const claudeSkills = path.join(home, ".claude", "skills");
const codexSkills = path.join(home, ".codex", "skills");
const cacheSkills = path.join(stateRoot, "skills");

function writeReference(root, skill, reference) {
  const filePath = path.join(root, skill, "references", reference);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, "# reference\n");
  return filePath;
}

const claudePlanSchema = writeReference(claudeSkills, "plan-write", "plan-schema.md");
const claudeLifecycle = writeReference(claudeSkills, "plan-write", "lifecycle.md");
const claudeWorkflowCreate = writeReference(claudeSkills, "plan-write", "workflow-create.md");
const claudeNested = writeReference(claudeSkills, "plan-write", path.join("nested", "deep.md"));
const codexReviewLoop = writeReference(codexSkills, "technical-writing", "review-loop.md");
const cachePlanSchema = writeReference(cacheSkills, "plan-write", "plan-schema.md");

// --- a reference read under either harness root is observed --------------------------------
{
  const context = observedReference(runHook(claudeHook, {
    tool_input: { file_path: claudePlanSchema },
  }));
  assert.match(context, /^\[skill-visibility\] observed reference read: plan-write\/references\/plan-schema\.md/,
    "a Claude skill reference read is reported as <skill>/<reference> under the [skill-visibility] tag");
}
{
  const context = observedReference(runHook(codexHook, {
    tool_input: { file_path: codexReviewLoop },
  }));
  assert.match(context, /observed reference read: technical-writing\/references\/review-loop\.md/,
    "Codex reads are observed too — either harness may have opened the reference");
}

// --- Codex observes the roborepo cache root when live shell payloads expose that path ----------
{
  const context = observedReference(runHook(codexHook, {
    tool_name: "exec_command",
    tool_input: { cmd: `sed -n '1,220p' ${cachePlanSchema}` },
  }));
  assert.match(context, /observed reference read: plan-write\/references\/plan-schema\.md/,
    "Codex sed payloads against the roborepo cache root are observed");
}

// --- nested references keep their full path --------------------------------------------------
{
  const context = observedReference(runHook(claudeHook, {
    tool_input: { file_path: claudeNested },
  }));
  assert.match(context, /plan-write\/references\/nested\/deep\.md/,
    "a reference in a subdirectory reports its path relative to the skill, not just its basename");
}

// --- everything else stays silent ------------------------------------------------------------
for (const [label, payload] of [
  ["a read outside any skill root", { tool_input: { file_path: "/etc/hosts" } }],
  ["a source file in the repo", { tool_input: { file_path: path.join(repoRoot, "scripts/cli/main.mjs") } }],
  // SKILL.md is the skill loading normally; only references/ answers "was the deep guidance opened".
  ["a skill entry point", { tool_input: { file_path: path.join(claudeSkills, "plan-write", "SKILL.md") } }],
  ["a skill file outside references/", { tool_input: { file_path: path.join(claudeSkills, "plan-write", "agents", "openai.yaml") } }],
  ["a missing reference path", { tool_input: { file_path: path.join(claudeSkills, "plan-write", "references", "missing.md") } }],
  ["a payload with no file_path", { tool_input: { command: "ls" } }],
  ["a payload with no tool_input", {}],
]) {
  assert.equal(runHook(claudeHook, payload), "", `${label} produces no output`);
}

for (const [label, payload] of [
  ["Codex source file shell read", { tool_name: "exec_command", tool_input: { cmd: `sed -n '1,20p' ${path.join(repoRoot, "scripts/cli/main.mjs")}` } }],
  ["Codex SKILL.md shell read", { tool_name: "exec_command", tool_input: { cmd: `sed -n '1,20p' ${path.join(cacheSkills, "plan-write", "SKILL.md")}` } }],
  ["Codex missing shell path", { tool_name: "exec_command", tool_input: { cmd: `sed -n '1,20p' ${path.join(cacheSkills, "plan-write", "references", "missing.md")}` } }],
  ["Codex unsupported cat syntax", { tool_name: "exec_command", tool_input: { cmd: `cat ${cachePlanSchema}` } }],
  ["Codex unsupported sed pipe", { tool_name: "exec_command", tool_input: { cmd: `sed -n '1,20p' ${cachePlanSchema} | head` } }],
]) {
  assert.equal(runHook(codexHook, payload), "", `${label} produces no output`);
}

// --- malformed stdin never disturbs the tool call ---------------------------------------------
{
  const result = spawnSync(process.execPath, [claudeHook], {
    input: "not json at all",
    encoding: "utf8",
    env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot },
  });
  assert.equal(result.status, 0, "unparseable input exits 0 rather than failing the tool call");
  assert.equal(result.stdout.trim(), "", "unparseable input produces no output");
}

// --- the managed cache root is provider-owned --------------------------------------------------
//
// Claude still matches only the path it receives from its direct file-read payloads. Codex includes
// the cache root because live shell payloads expose that path.
{
  assert.equal(runHook(claudeHook, { tool_input: { file_path: cachePlanSchema } }), "",
    "Claude does not treat the roborepo cache root as one of its direct read roots");
  const context = observedReference(runHook(codexHook, { tool_input: { file_path: cachePlanSchema } }));
  assert.match(context, /observed reference read: plan-write\/references\/plan-schema\.md/,
    "Codex treats the roborepo cache root as a declared root");
}

// --- symlinked paths are matched literally, never resolved -------------------------------------
//
// Mirrors the real install: ~/.claude/skills/<skill> symlinks to ~/.roborepo/skills/<skill>. A hook
// that called realpath would report the cache path here, or match nothing at all.
{
  const cacheSkill = path.join(home, ".roborepo", "skills", "linked-skill");
  fs.mkdirSync(path.join(cacheSkill, "references"), { recursive: true });
  fs.writeFileSync(path.join(cacheSkill, "references", "guide.md"), "# guide\n");
  fs.mkdirSync(claudeSkills, { recursive: true });
  const linkPath = path.join(claudeSkills, "linked-skill");
  if (!fs.existsSync(linkPath)) fs.symlinkSync(cacheSkill, linkPath);

  const context = observedReference(runHook(claudeHook, {
    tool_input: { file_path: path.join(linkPath, "references", "guide.md") },
  }));
  assert.match(context, /observed reference read: linked-skill\/references\/guide\.md/,
    "a read through a symlinked skill directory is observed under the path the agent used");
  assert.doesNotMatch(context, /roborepo/,
    "the resolved cache path must never appear — reporting it would name a path the agent never read");
}

// --- relative and traversal paths normalize without resolving symlinks -------------------------
{
  const traversal = path.join(claudeSkills, "plan-write", "workflows", "..", "references", "plan-schema.md");
  const context = observedReference(runHook(claudeHook, { tool_input: { file_path: traversal } }));
  assert.match(context, /observed reference read: plan-write\/references\/plan-schema\.md/,
    "`..` segments normalize away, since path.resolve normalizes without touching symlinks");
}

// --- observations are numbered per session so a compaction gap is detectable -------------------
//
// Injected context is ordinary context: compaction can drop it. Without a sequence number an agent
// cannot tell a dropped observation from a reference it never read. With one, a gap is positive
// evidence, which is what lets the rendered line say "unavailable" instead of guessing a tally.
{
  const session = "counter-session";
  const first = observedReference(runHook(claudeHook, {
    tool_input: { file_path: claudeLifecycle },
  }, { sessionId: session }));
  assert.match(first, /\(observation 1 this session\)$/, "the first observation of a session is numbered 1");

  const second = observedReference(runHook(claudeHook, {
    tool_input: { file_path: claudeWorkflowCreate },
  }, { sessionId: session }));
  assert.match(second, /\(observation 2 this session\)$/, "the counter increments within a session");

  const other = observedReference(runHook(claudeHook, {
    tool_input: { file_path: claudeLifecycle },
  }, { sessionId: "a-different-session" }));
  assert.match(other, /\(observation 1 this session\)$/, "a separate session starts its own count");
}

// --- the counter stores a count, never what was read -------------------------------------------
//
// Phase 9's persist-nothing constraint is relaxed for exactly one integer per session. This asserts
// the relaxation stays that narrow: no reference name may reach disk.
{
  const dir = path.join(stateRoot, "skill-visibility");
  for (const entry of fs.readdirSync(dir)) {
    const contents = fs.readFileSync(path.join(dir, entry), "utf8");
    assert.match(contents, /^\d+$/, `${entry} holds only a count`);
    assert.doesNotMatch(contents, /plan-write|references|\.md/,
      "no reference path or name is ever written to disk — the observation lives only in the injected text");
  }
}

// --- an unwritable state root degrades to an unnumbered observation ----------------------------
//
// Counting improves the message; it is never a precondition for it. A read-only state root must
// still produce an observation, just without a sequence number.
{
  const blocked = path.join(stateRoot, "blocked-file");
  fs.writeFileSync(blocked, "not a directory");
  const result = spawnSync(process.execPath, [claudeHook], {
    input: JSON.stringify({
      session_id: "blocked-session",
      tool_input: { file_path: claudePlanSchema },
    }),
    encoding: "utf8",
    // Pointing the state root at a regular file makes mkdirSync fail the way an unwritable root would.
    env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: blocked },
  });
  assert.equal(result.status, 0, "an unwritable state root still exits 0");
  const context = observedReference(result.stdout.trim());
  assert.match(context, /observed reference read: plan-write\/references\/plan-schema\.md$/,
    "the observation is still injected, without a sequence number");
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(stateRoot, { recursive: true, force: true });

console.log("skill-reference-observer: ok");
