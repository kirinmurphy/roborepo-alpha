#!/usr/bin/env node
// Session titles that name the plan stage: the formatter, the title hook command a harness runs on
// every prompt (through the real CLI, against a real plans store), and the rule text that states the
// format for the agent.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PLAN_SUITE_COMMANDS } from "../../modules/plan-suite/index.mjs";
import {
  SESSION_TITLE_MAX,
  STAGE_PREFIXES,
  TITLE_LINE_LABEL,
  hasStagePrefix,
  leadingPlanCommand,
  sessionTitle,
  titleFromPrompt,
  titleLine,
} from "../../modules/plan-suite/session-title.mjs";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

// --- Formatter --------------------------------------------------------------------------------

assert.equal(sessionTitle("plan-execute", "Session Titles"), "/plan-execute: Session Titles");
assert.equal(sessionTitle("sub-task", "Write the docs"), "/plan sub-task: Write the docs");
assert.equal(sessionTitle("quick-change", "Fix  the\n typo"), "Quick Change: Fix the typo", "whitespace collapses");
assert.equal(sessionTitle("plan-start", "x"), null, "a command outside the lifecycle has no prefix");
assert.equal(sessionTitle("plan-review", "   "), null, "an empty description sets no title");

const long = sessionTitle("plan-promote", "Give agent sessions a title that starts with the workflow stage they are in");
assert.ok(long.length <= SESSION_TITLE_MAX, `cut to ${SESSION_TITLE_MAX}: ${long} (${long.length})`);
assert.equal(long, "/plan-promote: Give agent sessions a title that starts…", "cut on a word boundary with an ellipsis");
const exact = `/plan-close: ${"a".repeat(SESSION_TITLE_MAX - "/plan-close: ".length)}`;
assert.equal(sessionTitle("plan-close", exact.slice("/plan-close: ".length)), exact, "a title at the limit is left whole");
const oneWord = sessionTitle("plan-write", "x".repeat(80));
assert.equal(oneWord.length, SESSION_TITLE_MAX, "a single overlong word is cut mid-word");
assert.ok(oneWord.startsWith("/plan-write: x") && oneWord.endsWith("…"));
// Two prefixes contain a space; an overlong first word must still leave them whole.
for (const [kind, prefix] of [["quick-change", "Quick Change: "], ["sub-task", "/plan sub-task: "]]) {
  const cut = sessionTitle(kind, "y".repeat(80));
  assert.equal(cut.length, SESSION_TITLE_MAX, `${kind}: cut to the limit`);
  assert.ok(cut.startsWith(`${prefix}y`) && cut.endsWith("…"), `${kind}: the prefix survives the cut: ${cut}`);
}
const lineCut = titleFromPrompt(`Session title: Quick Change: ${"z".repeat(80)}`);
assert.ok(lineCut.startsWith("Quick Change: z") && lineCut.length === SESSION_TITLE_MAX, `a title line keeps its prefix when cut: ${lineCut}`);

assert.deepEqual(
  STAGE_PREFIXES.filter((prefix) => prefix.startsWith("/plan-")).map((prefix) => prefix.slice(1, -1)).sort(),
  [...PLAN_SUITE_COMMANDS].sort(),
  "every plan command has a prefix, and only plan commands",
);
assert.equal(STAGE_PREFIXES.length, PLAN_SUITE_COMMANDS.size + 2, "plus sub-task and Quick Change");
assert.ok(hasStagePrefix("/plan-review: Thing"));
assert.ok(hasStagePrefix("Quick Change: Thing"));
assert.ok(!hasStagePrefix("My session"));
assert.ok(!hasStagePrefix("/plan-reviewer: Thing"));

assert.deepEqual(leadingPlanCommand("/plan-execute plans/ready/x.md"), { command: "plan-execute", rest: " plans/ready/x.md" });
assert.equal(leadingPlanCommand("  \n/plan-review").command, "plan-review", "leading blank lines are skipped");
assert.equal(leadingPlanCommand("please run /plan-review"), null, "the command must open the prompt");
assert.equal(leadingPlanCommand("/plan-reviewer x"), null);
assert.equal(leadingPlanCommand("/plan-suite-init"), null, "plan-suite-init works on no plan and gets no title");

assert.equal(titleFromPrompt(`/plan-execute\n\n${titleLine("/plan-execute: A Plan")}\nWork with plan`), "/plan-execute: A Plan");
assert.equal(titleFromPrompt("Session title: whatever I like"), null, "a title line without a stage prefix is ignored");

// --- Rule text states the same prefixes --------------------------------------------------------

const rules = fs.readFileSync(path.join(repoRoot, "globals/packages/plan-suite/rules.md"), "utf8");
const section = rules.slice(rules.indexOf("## Session Titles Name the Stage"));
assert.ok(section.startsWith("## Session Titles"), "the rule section exists");
const written = new Set([...section.matchAll(/`([^`]*?:)`/g)].map((match) => match[1]));
assert.deepEqual([...written].filter((prefix) => !prefix.includes("<") && prefix !== TITLE_LINE_LABEL).sort(), [...STAGE_PREFIXES].sort(),
  "the rule names every stage prefix the formatter uses, and no other");

// --- The hook command, through the CLI ----------------------------------------------------------

const fx = createPlanFixture("plan-session-title-");
try {
  const repo = fx.repository("repo", {
    "plans/ready/titles.md": planDoc({ id: "ttttt111", title: "Session Titles Show the Workflow Stage" }),
    "plans/backlog/other.md": planDoc({ id: "ooooo222", title: "Other Plan" }),
  });
  // The hook input arrives on standard input, which fx.roborepo does not pass.
  const cli = path.join(repoRoot, "scripts/cli/main.mjs");
  const run = (input, { harness = "claude", cwd = repo } = {}) => {
    const result = spawnSync(process.execPath, [cli, "plans", "session-title", "--harness", harness], {
      cwd, env: fx.env, input: typeof input === "string" ? input : JSON.stringify(input), encoding: "utf8",
    });
    assert.equal(result.status, 0, `the hook never fails a prompt:\n${result.stderr}`);
    assert.equal(result.stderr, "", "the hook is silent on stderr");
    return result.stdout.trim() ? JSON.parse(result.stdout).hookSpecificOutput : null;
  };

  // Recorded Claude input shape: no session_title field when no custom title is set.
  const base = { session_id: "s1", hook_event_name: "UserPromptSubmit", cwd: repo };
  assert.deepEqual(run({ ...base, prompt: "/plan-execute plans/ready/titles.md" }),
    { hookEventName: "UserPromptSubmit", sessionTitle: "/plan-execute: Session Titles Show the Workflow Stage" },
    "a typed plan command with a path titles the session after the plan's heading");
  assert.equal(run({ ...base, prompt: "/plan-review ttttt111" }).sessionTitle, "/plan-review: Session Titles Show the Workflow Stage",
    "a plan id names the plan");
  assert.equal(run({ ...base, prompt: "/plan-execute plans/backlog/titles.md" }).sessionTitle, "/plan-execute: Session Titles Show the Workflow Stage",
    "a path typed before the plan moved still finds it by file name");

  const copied = `/plan-execute\n\n${titleLine("/plan-execute: From The Title Line")}\nWork with plan \`ttttt111\` at \`plans/ready/titles.md\` in repository \`repo\`.`;
  assert.equal(run({ ...base, prompt: copied }).sessionTitle, "/plan-execute: From The Title Line", "a copied prompt's title line wins");

  assert.equal(
    run({ ...base, prompt: "/plan-review plans/ready/titles.md", session_title: "/plan-execute: Session Titles Show the Workflow Stage" }).sessionTitle,
    "/plan-review: Session Titles Show the Workflow Stage",
    "a stage title follows the session to its next stage",
  );
  assert.equal(run({ ...base, prompt: "/plan-write a faster widget cache" }).sessionTitle, "/plan-write: a faster widget cache",
    "a command naming no plan takes the words after it");

  const silent = [
    [{ ...base, prompt: "/plan-write" }, "a bare command with no words"],
    [{ ...base, prompt: "/plan-review ttttt111 ooooo222" }, "a prompt naming several plans"],
    [{ ...base, prompt: "/plan-review zzzz9999" }, "an unknown plan id, which must not become the title"],
    [{ ...base, prompt: "/plan-execute plans/ready/missing.md" }, "an unknown plan path"],
    [{ ...base, prompt: "please fix the build" }, "an ordinary prompt"],
    [{ ...base, prompt: "/plan-execute ttttt111", session_title: "My own name" }, "a hand-written title"],
    [{ ...base, prompt: "/plan-execute ttttt111", session_title: "/plan-execute: Session Titles Show the Workflow Stage" }, "the title it already has"],
    ["not json", "malformed input"],
    [[1, 2], "a JSON array"],
  ];
  for (const [input, label] of silent) assert.equal(run(input), null, `prints nothing for ${label}`);
  assert.equal(run({ ...base, prompt: "/plan-execute ttttt111" }, { harness: "codex" }), null, "Codex does not declare session-title");
  assert.equal(run({ ...base, prompt: "/plan-execute ttttt111" }, { harness: "nope" }), null, "an unknown harness");

  // Outside any plan store the command still titles from the prompt's own words, and stays silent.
  const bare = fx.repository("bare", {}, { store: false });
  assert.equal(run({ ...base, prompt: "/plan-write sketch a cache" }, { cwd: bare }).sessionTitle, "/plan-write: sketch a cache");
  assert.equal(run({ ...base, prompt: "/plan-review ttttt111" }, { cwd: bare }), null,
    "outside a store, a command that needs an existing plan sets no title");
} finally {
  fx.cleanup();
}

console.log("plan-session-title-check: ok");
