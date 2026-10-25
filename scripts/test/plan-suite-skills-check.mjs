#!/usr/bin/env node
// Dedicated coverage for the plan-suite command skills (plan-promote, plan-execute, plan-review,
// plan-close, plan-archive): discoverability, frontmatter parsing, generated-command wiring, package
// validation, and boundary text. Comparable skill-command packages (e.g. tighten) rely only on the
// generic catalog tests (package-catalog-check.mjs); these get their own file because their SKILL.md
// bodies encode explicit "do not" boundaries against each other and against the rest of the plan
// suite, which is worth asserting directly rather than only through the generic allowlist checks.
//
// The lifecycle moves these skills ask for are covered behaviorally by
// plan-lifecycle-transitions-check.mjs. What is asserted here is prose: the skills are
// agent-followed, so these phrases are what keep their ordering, delegation, and refusal behavior
// from eroding in later edits.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { loadPackageCatalog, validatePackageCatalog } from "../cli/package-catalog.mjs";
import { loadSlashCommandPlan } from "../cli/slash-commands.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const normalize = (text) => text.replace(/\s+/g, " ");
// The six plan skills ship in one package; session-close is its own.
const PLAN_SUITE_PACKAGE = "plan-suite";
const packageOf = (id) => (id.startsWith("plan-") ? PLAN_SUITE_PACKAGE : id);
const readSkill = (id) => normalize(fs.readFileSync(path.join(repoRoot, "globals/packages", packageOf(id), "skills", id, "SKILL.md"), "utf8"));
const readPackageFile = (relative) => normalize(fs.readFileSync(path.join(repoRoot, "globals/packages", relative), "utf8"));
const includesAll = (label, text, phrases) => {
  for (const phrase of phrases) assert.ok(text.includes(phrase), `${label}: missing "${phrase}"`);
};
// The rubric exists as two texts (validation-loop.md and plan-review's inline copy); both must carry
// the convention checks so an edit to one cannot silently drop them.
const CONVENTION_CHECK_PHRASES = ["Flow and cohesion", "Data and state", "Comments and abstractions", "length alone is never a finding"];

const SKILLS = {
  "plan-promote": {
    risk: "medium",
    boundaryPhrases: [
      "implement feature code",
      "create a feature branch or worktree",
      "change plan lifecycle, except the move from `backlog/` to `ready/`",
    ],
  },
  "plan-execute": {
    risk: "high",
    boundaryPhrases: [
      "create a second implementation plan",
      "change lifecycle state, except the start transition",
      "perform `/plan-review`'s human review, or record approval",
      "perform closeout or merge orchestration",
      "invoke another plan command",
    ],
    // Worktree-root resolution has no executable code path, so these phrases are the only
    // enforcement that the gate survives future edits: propose-and-wait on first use, then persist
    // so later runs on the same repository do not re-prompt.
    worktreeRootPhrases: [
      "worktreeRoot",
      "~/.worktrees",
      "wait for the user to confirm or override",
      "write the resulting path",
      "one-time gate per",
    ],
  },
  "plan-review": {
    risk: "high",
    boundaryPhrases: [
      "fix a finding that chooses between real alternatives, changes requirements, or changes a contract",
      "infer, assume, or record approval without the human's explicit answer",
      "merge the feature branch into the base branch, push, open or merge pull requests",
      "move a plan back to `ready/`",
    ],
  },
  "plan-close": {
    risk: "high",
    boundaryPhrases: [
      "fix agent-resolvable gaps before the verdict",
      "merge, push, delete branches, or remove worktrees",
      "manual-only `## Not tested` entries",
      "archive a plan; that is `/plan-archive`",
      "synchronize the base branch into the feature branch",
    ],
  },
  "plan-archive": {
    risk: "high",
    boundaryPhrases: [
      "archive a plan whose work has landed",
      "remove, reset, or delete a worktree or branch without the user's explicit authorization",
      "add archive fields to the frontmatter",
    ],
  },
};

// --- SKILL.md discoverability + frontmatter ---
for (const [id, { boundaryPhrases, worktreeRootPhrases = [] }] of Object.entries(SKILLS)) {
  const skillPath = path.join(repoRoot, "globals/packages", packageOf(id), "skills", id, "SKILL.md");
  assert.ok(fs.existsSync(skillPath), `${id}: SKILL.md missing at ${skillPath}`);
  const raw = fs.readFileSync(skillPath, "utf8");
  const frontmatterMatch = raw.match(/^---\n([\s\S]*?)\n---/);
  assert.ok(frontmatterMatch, `${id}: SKILL.md has no parsable frontmatter block`);
  assert.equal(frontmatterMatch[1].match(/^name:\s*(.+)$/m)?.[1].trim(), id, `${id}: frontmatter name must match folder name`);
  assert.ok(frontmatterMatch[1].match(/^description:\s*(.+)$/m)?.[1].trim(), `${id}: frontmatter description must be non-empty`);
  // Match against whitespace-normalized text: SKILL.md hard-wraps prose, so a phrase spanning a
  // line break would otherwise fail on the literal newline.
  const text = normalize(raw);
  includesAll(`${id} boundary`, text, boundaryPhrases);
  includesAll(`${id} worktree root`, text, worktreeRootPhrases);
}

// --- plan-execute: state-aware entry, the start transition, completion, and review findings ---
{
  const skill = readSkill("plan-execute");
  const reference = readPackageFile("plan-suite/skills/plan-execute/references/start-validation.md");
  includesAll("plan-execute entry", skill, [
    "| `backlog/` | Refuse. The plan has not been prepared; direct the user to `/plan-promote`. |",
    "| `ready/` | Preflight, the Start Transition",
    "| `active/` | Resume",
    "| `review/` | Fix findings",
    "A command never repeats a transition that has already happened",
  ]);
  assert.ok(skill.includes("Read `references/start-validation.md` before"), "plan-execute: SKILL.md must load the start-validation reference");
  assert.ok(skill.includes("canonical start transition command"), "plan-execute: SKILL.md must delegate the start transition");
  const order = ["## Start Transition", "## Enter the Worktree", "## Implementation Workflow", "## Validation Loop", "## Implementation Completion", "## Review Findings"].map((heading) => skill.indexOf(heading));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "plan-execute: start, enter, implement, validate, complete, then review findings");

  // The transition's steps must stay in this order: metadata, lifecycle move, plan-only commit,
  // fresh validation, and only then the context switch.
  const transition = skill.slice(order[0], order[1]);
  let cursor = -1;
  for (const step of [
    "writes `worktree: <name>` into the primary checkout's copy of the plan",
    "from `ready/` to `active/` with `git mv`",
    "only the old and new plan paths",
    "runs the start validator against fresh disk and Git state",
    "Enter the implementation worktree only after the validator returns `APPROVED`",
  ]) {
    const at = transition.indexOf(step);
    assert.ok(at > cursor, `plan-execute: start transition step missing or out of order: "${step}"`);
    cursor = at;
  }
  includesAll("plan-execute transition", transition, ["Do not push", "at most three correction passes", "not the checkout directory's basename", "configuration-only commit", "Unrelated work elsewhere in the primary checkout does not block it"]);
  includesAll("start-validation.md", reference, [
    "rev-parse --absolute-git-dir",
    "Never fold it into the transition commit",
    "Do not push",
    "at most three correction passes",
    "do not enter the target worktree",
    "reads every fact fresh",
    "lists only the plan's rename (`R`) or modification (`M`)",
    "status --porcelain -- <old path> <new path>",
    "Execution is still in the primary checkout",
    "stop and ask the user",
    "a `backlog/` plan is refused with a pointer to `/plan-promote`",
  ]);

  // The Validation Loop gate lives in SKILL.md so a run that never opens the reference is visibly
  // noncompliant; the procedure and rubric live in the reference.
  includesAll("plan-execute validation loop", skill.slice(order[3], order[4]), [
    "Read `references/validation-loop.md` before the first pass",
    "never the implementer's account of the work",
    "The Validator only reports",
    "A finding is classed by consequence, not size",
    "which is recorded and never blocks",
    "Never run the submit transition until a pass reports no `fix` findings",
    "five-pass cap",
  ]);
  includesAll("validation-loop.md", readPackageFile("plan-suite/skills/plan-execute/references/validation-loop.md"), [
    "## The loop",
    "## The rubric",
    "never pass `isolation: \"worktree\"`",
    "Do not give it a summary of what was built",
    "record in the plan that the Validator ran in-session",
    "| `fix` |",
    "| `escalate` |",
    "| `base` |",
    "Size never decides the class",
    "Cap at five passes",
    "A silent pass is indistinguishable from a skipped one",
    "only `/plan-review` writes `### Approval`",
    ...CONVENTION_CHECK_PHRASES,
    "A comment the diff adds that only restates the code | `fix`",
  ]);

  const completion = skill.slice(order[4], order[5]);
  includesAll("plan-execute completion", completion, [
    "Implementation completion is not approval",
    "has passed the Validation Loop",
    "canonical completion preflight command",
    "the plan stays in `active/`",
    "canonical submit transition command",
  ]);
  assert.ok(skill.slice(order[5]).includes("then run the Validation Loop over the result"), "plan-execute: fixes made in review mode are validated too");
  includesAll("plan-execute review findings", skill.slice(order[5]), [
    "nothing else is in scope",
    "A finding marked `fixed in review` is already resolved",
    "Never edit `### Approval`",
    "never run a lifecycle transition in this mode",
    "it needs `/plan-review`",
  ]);

  // Run mode: no check-ins, strict autonomy bar, queued questions batched at the end.
  includesAll("plan-execute run mode", skill, [
    "Do not stop for milestone, phase, or slice check-ins",
    "Do not ask the user anything during implementation",
    "Never invoke the next command",
    "Decide autonomously only when **all** of these hold",
    "Reversibility alone is not enough",
    "Always block, never decide",
    "## Decision Log",
    "## Open Questions",
    "every task that depends on it",
    "present every open entry to the user in one batch",
    "the run resumes in this same mode",
    "`model: sonnet`",
    "Never pass `isolation: \"worktree\"`",
    "reports it back instead of choosing",
    "## Not tested",
    "Never check an entry off yourself",
    // Entering the worktree is what stops per-file write prompts: the write-scope hook allows only the
    // checkout the session is in, so the skill must move the session there with one folder grant.
    "## Enter the Worktree",
    "request that access once using the environment's standard mechanism",
    "then make the worktree the session's working directory",
    "Follow repository-local access instructions when they exist",
  ]);
}

// --- plan authority: the worktree's copy is the plan while it is active or in review, and only
// the archive transition ever copies content between checkouts. The portal's side of the rule is
// covered behaviorally by the plan-suite checks. ---
{
  const execute = readSkill("plan-execute");
  const startReference = readPackageFile("plan-suite/skills/plan-execute/references/start-validation.md");
  for (const text of [execute, startReference]) {
    assert.ok(!/mirror|canonical copy|Plan status updates still go|synchronized in the matching plan document/i.test(text), "plan-execute: no instruction to copy plan updates to the primary checkout");
  }
  assert.ok(execute.includes("Never copy plan updates to the primary checkout"), "plan-execute: plan updates stay in the worktree's copy");
  assert.ok(startReference.includes("never a copy to the primary checkout"), "plan-execute: start-validation.md hands the plan to the worktree");

  const schema = readPackageFile("plan-suite/skills/plan-write/references/plan-schema.md");
  includesAll("plan-schema.md", schema, ["## Plan authority", "PLAN_EDITED_OUTSIDE_WORKTREE", "PLAN_WORKTREE_COPY_UNAVAILABLE", "never copy plan content between checkouts", "`active/` or `review/`"]);
  const write = readSkill("plan-write");
  assert.ok(write.includes("resolve its authoritative copy by the \"Plan authority\" rule"), "plan-write: resolves the authoritative copy before editing");
  assert.ok(write.includes("ask for write access to the worktree rather than editing the primary copy"), "plan-write: never falls back to the primary copy for access");

  const close = readSkill("plan-close");
  const integration = close.indexOf("### 0. Confirm the worktree's plan copy is integrated");
  assert.ok(integration > 0 && integration < close.indexOf("### 1. Run the tests"), "plan-close: the integration check runs before step 1");
  includesAll("plan-close integration", close, [
    "plan: not integrated",
    "make no plan edits",
    "Never copy the worktree's version into the primary checkout",
    "goes to the primary copy, including the notes of a later refusal",
    "Never edit the worktree's copy",
    "in `docs/plans/active/` or `docs/plans/review/`",
    "the worktree's plan state was not available",
  ]);

  const archive = readSkill("plan-archive");
  includesAll("plan-archive copy table", archive, [
    "canonical archive transition command",
    "Refuses with `conflicting copies`",
    "Writes the worktree copy's content into the primary copy",
    "the worktree's plan state was not available",
    "once, one way, at the archive transition",
    "Never merge two edited copies",
    "Archiving never removes a worktree or a branch",
  ]);
}

// --- plan-review: preflight, base synchronization, the check, fixes, the review packet, and approval ---
{
  const review = readSkill("plan-review");
  const order = ["### 1. Confirm implementation is complete", "### 2. Synchronize the base branch", "### 3. Check the work", "### 4. Record the review", "### 5. Fix what has a clear fix", "### 6. Present the review", "#### 6a.", "#### 6b.", "#### 6c."]
    .map((heading) => review.indexOf(heading));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "plan-review: preflight, sync, check, record, fix, present, then the three outcomes");
  // A finding is fixed in the same session by consequence, not by kind of change; only a choice
  // between alternatives, a requirement change, or an unspecified contract change waits for the human.
  includesAll("plan-review check", review.slice(order[2], order[3]), [
    "A failure the base branch has too is a **base failure**",
    "neither a finding nor a blocker",
    "never an account of the work",
    "Classify every finding by consequence, not size",
    ...CONVENTION_CHECK_PHRASES,
    "a comment the diff adds that only restates the code is a fix",
  ]);
  includesAll("plan-review fixes", review.slice(order[4], order[5]), [
    "Fix every finding classed **fix** in this session, code included",
    "Commit the fix on its own, separate from the plan record",
    "fixed in review (<short commit>)",
    "run another Validator pass over the result",
  ]);
  includesAll("plan-review packet", review.slice(order[5], order[6]), [
    "each acceptance criterion with the code and test evidence",
    "every commit this review made in step 5",
    "each escalated finding as a decision",
  ]);
  includesAll("plan-review", review, [
    "references/resume-review.md",
    "### Result",
    "- Status: pending",
    "- Base commit: <full base commit id>",
    "canonical completion preflight command",
    "canonical submit transition command",
    "canonical base synchronization command",
    "never discard work and never pick a side blindly",
    "Never merge the feature branch into the base branch",
    "Do not fix anything while checking. Record every finding first",
    "Plain checkboxes are enough for findings",
    "- Decision: approved",
    "- Reviewed implementation commit: <full commit id>",
    "- Confirmed by: human",
    "An agent cannot approve, and passing tests are not approval",
    "canonical approval check",
    "canonical reopen transition command",
    "never returns to `ready/`",
    "Do not invoke either command yourself",
    "`/plan-close` never synchronizes",
  ]);
  const resume = readPackageFile("plan-suite/skills/plan-review/references/resume-review.md");
  includesAll("plan-review resume", resume, [
    "roborepo plans approval <plan> --json",
    "already approved",
    "already closed",
    "Approval only",
    "review.baseChangedPaths",
    "Record the existing answer immediately",
    "finish only step 3",
    "This recovery records approval; it does not close, merge, push, or waive tests",
  ]);
}

// --- plan-promote: commits the move to ready through the transition command ---
{
  const promote = readSkill("plan-promote");
  includesAll("plan-promote", promote, [
    "canonical promote transition command",
    "refuses, with the findings and a repair prompt",
    "/plan-execute <plan document file>",
    "Never invoke `/plan-execute` yourself",
  ]);
  assert.ok(!promote.includes("/plan-start"), "plan-promote: hands off to /plan-execute");
}

// --- suite-wide conventions: every plan-suite skill checks its paired packages before loading them,
// names no retired command, and /plan-close repairs agent-resolvable gaps before refusing. ---
{
  // Assembled from parts so this guard does not itself contain the retired names.
  const RETIRED_COMMANDS = [["plan", "docs"], ["wrap", "up"], ["integration", "check"], ["plan", "start"], ["plan", "ship"]].map((parts) => parts.join("-"));
  const suite = ["plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive", "session-close"];
  for (const id of suite) {
    const skill = readSkill(id);
    includesAll(`${id} paired skills`, skill, ["## Paired Skills", "host's skill/package manager", "Enable it, or skip it for this run?", "never describe a drifted package as loaded"]);
    if (id !== "session-close") includesAll(`${id} plan naming`, skill, ["Name the plan by its H1 title, with its id in parentheses on first mention only"]);
    if (!["plan-write", "session-close"].includes(id)) includesAll(`${id} report names the plan`, skill, ['- Plan: "<title>" (<id>), <repository-relative path>']);
    for (const retired of RETIRED_COMMANDS) {
      assert.ok(!skill.includes(`/${retired}`), `${id}: SKILL.md still names the retired /${retired}`);
    }
  }

  const close = readSkill("plan-close");
  const order = ["### 1. Run the tests", "### 3. Check the plan against the code", "### 5. Confirm `## Not tested` is clear", "### 6. Confirm a fresh human approval", "### 7. Confirm the work landed", "### 8. Close", "### 9. Stop the worktree's servers", "### 10. Remove the closed worktree"]
    .map((heading) => close.indexOf(heading));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "plan-close: tests, verdict, Not tested, approval, landed, close, stop servers, then cleanup, in that order");
  for (const phrase of [
    "Close from docs/plans/review/",
    "### Idempotent retries",
    "Do not rerun tests, seek another approval, edit the plan, or make another closure commit",
    "`- Absorbing commit: <full commit id>`",
    "the absorbing commit is still in the selected base branch's first-parent history",
    "A verified commit is reused instead of scanning base history again",
    "after the recorded landing is never covered by it",
    "verifies the recorded absorbing commit itself",
    "single post-merge action",
    "continue independent agent-resolvable work",
    "Prefer the repository's canonical CI command over a broad",
    "release-only or",
    "availability of optional tools or environment fixtures is not a closure prerequisite",
    "The work must be in the base branch, including after a squash or rebase merge",
    "first-parent commits",
    "landed: unconfirmed",
    "UNCONFIRMED_NOT_TESTED",
    "canonical landed check",
    "canonical approval check",
    "canonical close transition command",
    "direct the user to `/plan-archive`",
    "never as passed",
    "add a missing regression test",
    "rerun the affected checks",
    "manual-only `## Not tested` entries",
    "canonical linked-worktree server cleanup command",
    "canonical worktree cleanup command scoped to this plan",
    "Skip this step for an archived or refused plan",
    "## Refusal and blocker reporting",
    "report every issue explicitly",
    "the exact plan entry",
    "user-visible behavior",
    "expected and observed outcome",
    "Would you like help resolving any of these issues?",
  ]) {
    assert.ok(close.toLowerCase().includes(phrase.toLowerCase()), `plan-close: SKILL.md missing "${phrase}"`);
  }
}

// --- plans-config.json stays valid JSON and, when present, worktreeRoot is a well-formed string ---
// worktreeRoot is optional (a user can remove it to re-trigger plan-execute's first-time
// confirmation gate), so this only asserts the shape when the key exists rather than requiring it.
{
  const configPath = path.join(repoRoot, "docs/plans/plans-config.json");
  assert.ok(fs.existsSync(configPath), `plans-config.json missing at ${configPath}`);
  const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
  if ("worktreeRoot" in config) {
    assert.equal(typeof config.worktreeRoot, "string", "worktreeRoot must be a string when present");
    assert.ok(config.worktreeRoot.trim().length > 0, "worktreeRoot must not be an empty string when present");
  }
}

// --- package.config.json loads and validates through the real catalog ---
const catalog = loadPackageCatalog({ includeUnavailable: true });
validatePackageCatalog(catalog);

const byId = new Map(catalog.map((pkg) => [pkg.id, pkg]));
assert.ok(!byId.has("plan-start"), "plan-start is retired, with no compatibility alias");
assert.ok(!byId.has("plan-ship"), "there is no plan-ship command");
assert.ok(byId.has(PLAN_SUITE_PACKAGE), `catalog missing package: ${PLAN_SUITE_PACKAGE}`);
for (const id of ["plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive"]) {
  assert.ok(!byId.has(id), `${id} is a skill of ${PLAN_SUITE_PACKAGE}, not a package of its own`);
}
assert.deepEqual(
  byId.get(PLAN_SUITE_PACKAGE).resources.filter((r) => r.type === "skill").map((r) => r.id),
  ["plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive"],
  `${PLAN_SUITE_PACKAGE} lists its skills in lifecycle order`,
);
for (const [id, { risk }] of Object.entries(SKILLS)) {
  const skillResource = byId.get(PLAN_SUITE_PACKAGE).resources.find((r) => r.type === "skill" && r.id === id);
  assert.ok(skillResource, `${PLAN_SUITE_PACKAGE}: package.config.json has no ${id} skill resource`);
  assert.equal(skillResource.invocation, "manual", `${id}: skill resource should be manually invoked`);
  assert.equal(skillResource.risk, risk, `${id} should be risk: ${risk}`);
}
assert.ok(byId.get(PLAN_SUITE_PACKAGE).resources.some((r) => r.type === "rules" && r.source === "rules.md"), `${PLAN_SUITE_PACKAGE} carries the Code Outlives Plans rule`);
assert.match(fs.readFileSync(path.join(repoRoot, "globals/packages", PLAN_SUITE_PACKAGE, "rules.md"), "utf8"), /^## Code Outlives Plans$/m);

// --- generated slash commands exist for every harness and point at the right SKILL.md ---
const slashNames = new Set(loadSlashCommandPlan().commands.map((c) => c.name));
assert.ok(!slashNames.has("plan-start"), "no plan-start slash command remains");
for (const id of Object.keys(SKILLS)) assert.ok(slashNames.has(id), `missing slash command: ${id}`);
assert.ok(!fs.existsSync(path.join(repoRoot, "generated/packages/plan-start")), "no generated plan-start projection remains");

for (const harness of ["claude", "codex", "gemini"]) {
  for (const id of Object.keys(SKILLS)) {
    const generatedPath = path.join(repoRoot, "generated/packages", PLAN_SUITE_PACKAGE, harness, "commands", `${id}.md`);
    assert.ok(fs.existsSync(generatedPath), `missing generated command: ${generatedPath}`);
    const body = fs.readFileSync(generatedPath, "utf8");
    assert.ok(body.includes(`/${harness === "claude" ? ".claude" : harness === "codex" ? ".codex" : ".gemini"}/skills/${id}/SKILL.md`),
      `${generatedPath} does not reference the correct SKILL.md read path`);
  }
}

// --- package validation via the real CLI ---
{
  const result = spawnSync(process.execPath, [cli, "package", "validate", PLAN_SUITE_PACKAGE], { cwd: repoRoot, encoding: "utf8" });
  assert.equal(result.status, 0, `roborepo package validate ${PLAN_SUITE_PACKAGE} failed: ${result.stderr}\n${result.stdout}`);
}

console.log("ok: plan-suite command skills: discoverability, frontmatter, generated commands, and boundaries");
