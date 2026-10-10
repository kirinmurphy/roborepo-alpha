#!/usr/bin/env node
// Smoke check for the skill-visibility count file: the one thing the PostToolUse hook persists
// to disk. The hook's injected `additionalContext` is never written to a session transcript — it
// lives only in the model's context for the turn that received it — so a post-hoc check cannot
// verify the injection reached the agent. What it can verify is the durable half of the contract:
// the hook runs, writes `<session>.count`, and that file's value tracks the number of reference
// reads exactly, in order, across concurrent sessions, without ever naming what was read.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hook = path.join(repoRoot, "globals/packages/skill-visibility/hooks/claude/skill-reference-observer.mjs");

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-visibility-count-home-"));
const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-visibility-count-state-"));
const claudeSkills = path.join(home, ".claude", "skills");

function readReference(sessionId, skill, reference) {
  const filePath = path.join(claudeSkills, skill, "references", reference);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  if (!fs.existsSync(filePath)) fs.writeFileSync(filePath, "# reference\n");
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: sessionId, tool_input: { file_path: filePath } }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot },
  });
  assert.equal(result.status, 0, `hook must exit 0; got ${result.status} (${result.stderr})`);
  return result.stdout.trim();
}

function countFileValue(sessionId) {
  const file = path.join(stateRoot, "skill-visibility", `${sessionId}.count`);
  return Number.parseInt(fs.readFileSync(file, "utf8"), 10);
}

// --- the count file tracks reference reads one-for-one, in order ------------------------------
{
  const session = "smoke-session-a";
  const reads = [
    ["plan-write", "plan-schema.md"],
    ["plan-write", "lifecycle.md"],
    ["plan-write", "workflow-validate.md"],
  ];
  reads.forEach(([skill, reference], i) => {
    const stdout = readReference(session, skill, reference);
    const parsed = JSON.parse(stdout);
    const expected = i + 1;
    assert.match(
      parsed.hookSpecificOutput.additionalContext,
      new RegExp(`\\(observation ${expected} this session\\)$`),
      `read ${i + 1} must be numbered ${expected} in the injected line`,
    );
  });
  assert.equal(
    countFileValue(session),
    reads.length,
    "the count file must equal the number of reference reads for this session",
  );
}

// --- a non-reference read (SKILL.md, a source file) never advances the counter ------------------
{
  const session = "smoke-session-b";
  readReference(session, "plan-write", "plan-schema.md");
  const skillEntryPoint = path.join(claudeSkills, "plan-write", "SKILL.md");
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ session_id: session, tool_input: { file_path: skillEntryPoint } }),
    encoding: "utf8",
    env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot },
  });
  assert.equal(result.stdout.trim(), "", "a SKILL.md read produces no injection");
  assert.equal(countFileValue(session), 1, "the counter must not advance on a non-reference read");
}

// --- concurrent sessions never share a counter ---------------------------------------------------
{
  const sessionX = "smoke-session-x";
  const sessionY = "smoke-session-y";
  readReference(sessionX, "plan-write", "plan-schema.md");
  readReference(sessionX, "plan-write", "lifecycle.md");
  readReference(sessionY, "plan-write", "plan-schema.md");
  assert.equal(countFileValue(sessionX), 2, "session x keeps its own count");
  assert.equal(countFileValue(sessionY), 1, "session y starts its own count, unaffected by session x");
}

fs.rmSync(home, { recursive: true, force: true });
fs.rmSync(stateRoot, { recursive: true, force: true });

console.log("skill-visibility-count-file: ok");
