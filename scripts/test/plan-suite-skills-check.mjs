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
// The plan skills ship in one package; session-close is its own.
const PLAN_SUITE_PACKAGE = "plan-suite";
const packageOf = (id) => (id.startsWith("plan-") ? PLAN_SUITE_PACKAGE : id);
const readSkill = (id) => normalize(fs.readFileSync(path.join(repoRoot, "globals/packages", packageOf(id), "skills", id, "SKILL.md"), "utf8"));
const readPackageFile = (relative) => normalize(fs.readFileSync(path.join(repoRoot, "globals/packages", relative), "utf8"));
const includesAll = (label, text, phrases) => {
  for (const phrase of phrases) assert.ok(text.includes(phrase), `${label}: missing "${phrase}"`);
};
// The review rubric lives once, in implementation-review; every caller points to it instead of
// carrying a copy, so these phrases are asserted there and asserted absent from the callers.
const CONVENTION_CHECK_PHRASES = ["Flow and cohesion", "Data and state", "Comments and abstractions", "length alone is never a finding"];
const OUTSIDE_SCOPE_PHRASES = ["Issues the work under review did not cause are not findings", "`Outside this scope`"];
const RISK_CHECKPOINT_PHRASES = ["authentication;", "authorization, ownership, and admin;", "database schema and migrations;", "external integrations."];

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
      "perform closeout, or merge the feature branch or its pull request into the base",
      "invoke another plan command",
    ],
    // The root is confirmed once by /plan-suite-init; this skill only reads the result.
    worktreeRootPhrases: [
      "worktreeRoot",
      "worktreeRepoName",
    ],
  },
  "plan-review": {
    risk: "high",
    boundaryPhrases: [
      "fix a finding that chooses between real alternatives, changes requirements, or changes a contract",
      "infer, assume, or record approval without the human's explicit answer",
      "merge the feature branch into the base branch, push anything but the plan's feature branch, open or merge pull requests",
      "move a plan back to `ready/`",
    ],
  },
  "plan-close": {
    risk: "high",
    boundaryPhrases: [
      "fix agent-resolvable gaps before the verdict",
      "merge, push, delete branches, or remove worktrees",
      "run, check off, or remove a `## Not tested` entry",
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
  includesAll("plan-execute final report routing", skill, [
    "Before the final report in every execution mode (start, resume, and review findings), read",
    "[references/final-report.md](references/final-report.md) and follow its required template and reporting checklist",
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
    "writes `worktree: <name>` into the plan",
    "from `ready/` to `active/`",
    "only the old and new plan paths",
    "runs the start validator against fresh disk and Git state",
    "Enter the implementation worktree only after the validator returns `APPROVED`",
  ]) {
    const at = transition.indexOf(step);
    assert.ok(at > cursor, `plan-execute: start transition step missing or out of order: "${step}"`);
    cursor = at;
  }
  includesAll("plan-execute transition", transition, ["at most three correction passes", "not the checkout directory's basename"]);
  includesAll("start-validation.md", reference, [
    "rev-parse --absolute-git-dir",
    "at most three correction passes",
    "do not enter the target worktree",
    "reads every fact fresh",
    "lists only the plan's move or modification",
    "status --porcelain -- <old path> <new path>",
    "The plans worktree is on `repo-plans`",
    "a `backlog/` plan is refused with a pointer to `/plan-promote`",
  ]);

  // The Validation Loop gate lives in SKILL.md so a run that never opens the reference is visibly
  // noncompliant; the procedure and rubric live in the reference.
  includesAll("plan-execute validation loop", skill.slice(order[3], order[4]), [
    "Read `references/validation-loop.md` before the first pass",
    "never the implementer's account of the work",
    "The Validator only reports",
    "Findings carry `implementation-review`'s severity and class",
    "which is recorded and never blocks",
    "Never run the submit transition until the loop has ended",
    "without asking the user",
    "eight-pass cap",
  ]);
  const loop = readPackageFile("plan-suite/skills/plan-execute/references/validation-loop.md");
  for (const phrase of [...CONVENTION_CHECK_PHRASES, "## The rubric", "| `escalate` |"]) {
    assert.ok(!loop.includes(phrase), `validation-loop.md: the rubric moved to implementation-review, but "${phrase}" is still here`);
  }
  includesAll("validation-loop.md", loop, [
    "the `implementation-review` skill's rubric",
    "load it before the first pass",
    "A `note` is shown in the pass's report and not recorded",
    "no `blocking` or `actionable` `fix` findings",
    "never pass `isolation: \"worktree\"`",
    "Do not give it a summary of what was built",
    "record in the plan that the Validator ran in-session",
    "Never ask the user whether to fix a `fix` finding",
    "Cap at eight passes",
    "the eighth pass's findings are recorded and fixed like any other pass's",
    "only `/plan-review` writes `### Approval`",
  ]);

  const completion = skill.slice(order[4], order[5]);
  includesAll("plan-execute completion", completion, [
    "Implementation completion is not approval",
    "has passed the Validation Loop",
    "canonical completion preflight command",
    "the plan stays in `active/`",
    "`roborepo plans submit <plan> --json`",
  ]);
  // Every run that commits to the feature branch pushes it, not only the review handoff.
  const handoffReference = normalize(readPackageFile("plan-suite/skills/plan-execute/references/handoff.md"));
  includesAll("plan-execute push", `${skill}\n${handoffReference}`, [
    "Every run that commits to the feature branch ends by pushing it",
    "when the plan stays in `active/`",
    "never the base branch or any other protected branch",
    "Never force-push",
  ]);
  // The handoff merges the base in without asking, so a pull request never arrives with conflicts,
  // and never merges the other way.
  const handoff = handoffReference.slice(handoffReference.indexOf("## Hand off"));
  includesAll("plan-execute handoff authorization", skill, [
    "Invoking `/plan-execute` authorizes this merge of the base into the plan's own feature branch",
    "Merging the feature branch into the base stays forbidden",
    "[references/handoff.md](references/handoff.md)",
  ]);
  includesAll("plan-execute handoff", handoff, [
    "After the submit transition, and after Review Findings commits its fixes",
    "`roborepo plans sync-base --base <base> --json`",
    "authorizes this merge of the base into the plan's own feature branch",
    "Merging the feature branch into the base stays forbidden",
    "Regenerate a generated file from its sources",
    "`roborepo plans sync-base --continue --base <base> --json`",
    "An existing open pull request whose base is not `<base>` is not edited or readied",
    "`git ls-remote <remote> refs/heads/<branch>` prints `HEAD`'s commit",
    "its checks apply to the commit GitHub has, not to the local work",
    "report the conflicting paths and the choice under Needs you",
    "run the checks for the files it touched",
    "`roborepo delivery pr-body <file>`",
    "Never merge it, enable auto-merge, or approve it",
    "whether it merges cleanly, and CI's result so far",
  ]);
  const ordered = ["1. **Merge the base in.**", "4. **Recheck what the merge changed.**", "5. **Push**", "6. **Open or update the pull request**", "7. **Report its state:**"].map((step) => handoff.indexOf(step));
  assert.ok(ordered.every((at, i) => at > 0 && (i === 0 || at > ordered[i - 1])), "plan-execute: merge, recheck, push, then the pull request and its state");
  assert.ok(completion.includes("Then hand off the feature branch"), "plan-execute: submit hands the branch off");
  assert.ok(skill.slice(order[5]).includes("Hand off the feature branch (see Push and hand off the feature branch)"), "plan-execute: review-findings fixes hand the branch off");
  assert.ok(skill.slice(order[5]).includes("then run the Validation Loop over the result"), "plan-execute: fixes made in review mode are validated too");
  includesAll("plan-execute review findings", skill.slice(order[5]), [
    "nothing else is in scope",
    "A finding marked `fixed in review` is already resolved",
    "Never edit `### Approval`",
    "never run a lifecycle transition in this mode",
    "it needs `/plan-review`",
  ]);

  // Run mode: no check-ins, clear wins decided without asking, queued questions batched at the end.
  includesAll("plan-execute run mode", skill, [
    "Do not stop for milestone, phase, or slice check-ins",
    "Do not ask the user anything during implementation",
    "Never invoke the next command",
    "Decide autonomously when one option is clearly the best and no alternative has a compelling argument for it",
    "two or more options each have a compelling argument",
    "Reversibility alone does not settle it",
    "Always block, never decide",
    "## Decision Log",
    "## Open Questions",
    "every task that depends on it",
    "present every open entry to the user in one batch",
    "the run resumes in this same mode",
    "Launch them on a cheaper model where the harness offers a choice",
    "Never pass `isolation: \"worktree\"`",
    "reports it back instead of choosing",
    "## Not tested",
    // The agent runs what it can before the user is asked, and every entry it leaves says why.
    "Run every check an agent can run before submitting",
    "attempt every `## Not tested` entry",
    "`— Verified by agent <date> at <commit>: <command or method> → <result>`",
    "`Blocked: <exact command> failed with <error>`",
    "`Needs a person: <why an agent cannot>`",
    "Not an entry: a defect",
    "as a bare call, with no pipe, `cd`, or chained command",
    "Never check off a person-only entry on your own judgment",
    "`roborepo plans submit` refuses while an open entry gives no reason or a cleared one has no evidence",
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
  assert.ok(execute.includes("The plan is never a file on the feature branch"), "plan-execute: plan updates go through the store");
  assert.ok(startReference.includes("never a file on the feature branch"), "plan-execute: start-validation.md keeps the plan on the plans branch");

  const schema = readPackageFile("plan-suite/skills/plan-write/references/plan-schema.md");
  includesAll("plan-schema.md", schema, ["## Plan store", "`roborepo plans save <file.md>`", "`synchronized: false`", "Never write to `repo_plans` directly"]);
  // The entry format every plan skill reads: who may leave an entry open, who may clear it, and how.
  includesAll("plan-schema.md Not tested", schema, [
    "An agent runs every check it can before leaving an entry for the user",
    "`Needs a person: <why an agent cannot>`",
    "`Blocked: <exact command> failed with <error>`",
    "`— Verified by agent <date> at <commit>: <command or method> → <result>`",
    "`— Confirmed by the user <date>: <what they reported>`",
    "\"No time\" and \"no test exists\" are not reasons",
    "An agent never checks off a person-only entry on its own judgment",
    "An agent never clears an entry without a resolution that names the passing evidence",
    "never grants or infers human approval",
    "`NOT_TESTED_UNEXPLAINED`",
    "`roborepo plans preflight` and the move into `review/` refuse it",
  ]);
  assert.ok(!schema.includes("Only the user clears an entry"), "plan-schema.md: an agent clears what it can verify");
  includesAll("workflow-validate.md", readPackageFile("plan-suite/skills/plan-write/references/workflow-validate.md"), [
    "`NOT_TESTED_UNEXPLAINED`",
    "`roborepo plans submit` and `plans preflight` refuse the second",
  ]);
  includesAll("session-close", readSkill("session-close"), ["Run a check an agent can run instead of listing it", "`Needs a person: <why>`"]);
  includesAll("feature-verification", readSkill("feature-verification"), ["Run `roborepo browser run --serve` as a bare call"]);
  const write = readSkill("plan-write");
  assert.ok(write.includes("Change a plan only through `roborepo plans save`"), "plan-write: writes through the store, not before editing");

  const close = readSkill("plan-close");
  assert.ok(!close.includes("### 0."), "plan-close: there is one copy, so nothing reconciles copies before the tests");

  const archive = readSkill("plan-archive");
  includesAll("plan-archive", archive, [
    "`roborepo plans archive <plan> --reason <text> --json`",
    "Archiving never removes a worktree or a branch",
  ]);
}

// --- plan-review: preflight, base synchronization, the check, fixes, the review packet, and approval ---
{
  const review = readSkill("plan-review");
  includesAll("plan-review push", review, [
    "Every review run that commits to the feature branch",
    "then push the feature branch (see Push the feature branch)",
    "never the base branch or any other protected branch",
    "Never force-push",
  ]);
  const order = ["### 1. Confirm implementation is complete", "### 2. Synchronize the base branch", "### 3. Check the work", "### 4. Record the review", "### 5. Fix what has a clear fix", "### 6. Present the review", "#### 6a.", "#### 6b.", "#### 6c."]
    .map((heading) => review.indexOf(heading));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "plan-review: preflight, sync, check, record, fix, present, then the three outcomes");
  // A finding is fixed in the same session by consequence, not by kind of change; only a choice
  // between alternatives, a requirement change, or an unspecified contract change waits for the human.
  includesAll("plan-review check", review.slice(order[2], order[3]), [
    "A failure the base branch has too is a **base failure**",
    "neither a finding nor a blocker",
    "never an account of the work",
    "loads `implementation-review` and applies its rubric",
    "Each finding carries the rubric's severity and class",
    "`Outside this scope`",
  ]);
  for (const phrase of CONVENTION_CHECK_PHRASES) {
    assert.ok(!review.includes(phrase), `plan-review: the rubric lives in implementation-review, but "${phrase}" is still inline`);
  }
  includesAll("plan-review fixes", review.slice(order[4], order[5]), [
    "Fix every finding classed **fix** in this session, code included",
    "Commit the fix on its own, separate from the plan record",
    "fixed in review (<short commit>)",
    "run another Validator pass over the result",
    "without asking the human",
    "the eighth pass's findings are fixed like any other pass's",
  ]);
  // The packet shows plain outcomes first; commits and evidence detail are offered on request.
  const packet = review.slice(order[5], order[6]);
  const secondLayer = packet.indexOf("The second layer is offered in one line and given when the human asks");
  assert.ok(secondLayer > 0, "plan-review: packet offers a second layer on request");
  includesAll("plan-review packet first layer", packet.slice(0, secondLayer), [
    "`/plan-write`'s `references/completion-report.md`",
    "what the plan is for, in one sentence",
    "the acceptance criteria as a plain checklist of outcomes",
    "each escalated finding as a decision",
  ]);
  includesAll("plan-review packet second layer", packet.slice(secondLayer), [
    "the code and test evidence behind each criterion",
    "each Validator pass's findings",
    "every commit this review made in step 5",
  ]);
  includesAll("plan-review exact-commit approval", packet, ["Then ask the human directly for approval, naming the plan by its title and the exact commit"]);
  const checkerAt = packet.indexOf("Before showing the first layer, run the checker agent");
  assert.ok(checkerAt > secondLayer && checkerAt < packet.indexOf("Then ask the human directly for approval"),
    "plan-review: the checker agent reads the packet before approval is asked");
  includesAll("plan-review", review, [
    "references/resume-review.md",
    "### Result",
    "- Status: pending",
    "- Base commit: <full base commit id>",
    "`roborepo plans preflight <plan> --json`",
    "`roborepo plans submit <plan> --json`",
    "canonical base synchronization command",
    "fast-forwards a stale local base",
    "`/plan-execute` runs the same command when it hands the plan off",
    "never discard work and never pick a side blindly",
    "Never merge the feature branch into the base branch",
    "Do not fix anything while checking. Record every finding first",
    "A long gate does not hold up work that cannot change its result",
    "through the harness's structured question tool where one exists",
    "Say plainly that approval was not requested",
    "Plain checkboxes are enough for findings",
    "- Decision: approved",
    "- Reviewed implementation commit: <full commit id>",
    "- Confirmed by: human",
    "An agent cannot approve, and passing tests are not approval",
    "`roborepo plans approval <plan> --json`",
    "`roborepo plans approve <plan> --commit <full reviewed commit id> --confirmed-by <who>`",
    // Review runs what an agent can and asks the human only for the rest. Whether an entry's reason
    // holds is part of implementation-review's checklist, asserted in its own block.
    "run the check here and clear the entry with its evidence",
    "Retry each `Blocked:` entry once",
    "the checks only the human can make",
    "the commands to allow",
    "never a request to the human",
    "Check a person-only entry off only from the human's explicit answer, quoting it",
    "`roborepo plans reopen <plan> --json`",
    "never returns to `ready/`",
    "Do not invoke either command yourself",
    "`/plan-close` never synchronizes",
    "A complete review awaiting approval must include step 6's exact-commit approval question",
  ]);
  const resume = readPackageFile("plan-suite/skills/plan-review/references/resume-review.md");
  includesAll("plan-review resume", resume, [
    "roborepo plans approval <plan> --json",
    "already approved",
    "already closed",
    "Approval only",
    "review.baseChangedPaths",
    "Record the existing answer immediately",
    "it does not close, merge, or waive tests",
  ]);
}

// --- plan-promote: commits the move to ready through the transition command ---
{
  const promote = readSkill("plan-promote");
  includesAll("plan-promote", promote, [
    "`roborepo plans promote <plan> --json`",
    "refuses, with the findings and a repair prompt",
    "/plan-execute <plan document file>",
    "Never invoke `/plan-execute` yourself",
  ]);
}

// --- suite-wide conventions: every plan-suite skill declares its paired skills with the package
// relationship, never prompts to enable a package, and /plan-close repairs agent-resolvable gaps
// before refusing. ---
{
  const suite = ["plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive", "session-close"];
  for (const id of suite) {
    const skill = readSkill(id);
    includesAll(`${id} paired skills`, skill, ["## Paired Skills", "| Skill | Relationship | Load when | Contributes |", "the paired-skill rule in Skill Loading", "Never ask the user to enable a package"]);
    for (const phrase of ["Enable it, or skip it", "host's skill/package manager"]) {
      assert.ok(!skill.includes(phrase), `${id}: paired skills no longer run an enable-or-skip check ("${phrase}")`);
    }
    if (id !== "session-close") includesAll(`${id} plan naming`, skill, ["Name the plan by its H1 title, with its id in parentheses on first mention only"]);
    if (["plan-promote", "plan-execute"].includes(id)) {
      const report = id === "plan-execute"
        ? readPackageFile("plan-suite/skills/plan-execute/references/final-report.md")
        : skill;
      includesAll(`${id} report names the plan`, report, ['- Plan: "<title>" (<id>), <store-relative path>']);
    }
  }

  // Every plan command reads the one shared completion-report reference before reporting, and the
  // commands that end a stage of work run the checker agent; the short reports self-check.
  const SHARED_REPORT = "`/plan-write`'s `references/completion-report.md`";
  const reportSections = {
    // plan-write ends with its Completion Report, so its section runs to the end of the file.
    "plan-write": ["## Completion Report", null],
    "plan-promote": ["## Completion Result", "## Boundaries"],
    "plan-review": ["## Final Report", "## Boundaries"],
    "plan-close": ["## Final Report", "## Boundaries"],
    "plan-archive": ["## Final Report", "## Boundaries"],
  };
  for (const [id, [startHeading, endHeading]] of Object.entries(reportSections)) {
    const skill = readSkill(id);
    const reportStart = skill.indexOf(startHeading);
    const end = endHeading ? skill.indexOf(endHeading, reportStart) : -1;
    assert.ok(reportStart >= 0, `${id}: has a ${startHeading} section`);
    const report = end > reportStart ? skill.slice(reportStart, end) : skill.slice(reportStart);
    const pointer = id === "plan-write" ? "`references/completion-report.md`" : SHARED_REPORT;
    includesAll(`${id} shared report`, report, [pointer]);
    const check = ["plan-write", "plan-archive"].includes(id) ? "in-session self-check" : "checker agent";
    includesAll(`${id} cold-reader check`, report, [check]);
    if (id !== "plan-promote") assert.ok(!report.includes("```text"), `${id}: report has no fixed status template`);
    assert.ok(!report.includes("where it applies"), `${id}: visual evidence is required, not optional`);
  }
  includesAll("plan-write lists the shared report reference", readSkill("plan-write"), [
    "Before the completion report, read `references/completion-report.md`",
  ]);
  const executeReport = readPackageFile("plan-suite/skills/plan-execute/references/final-report.md");
  includesAll("plan-execute final report asks only for what an agent cannot do", executeReport, [
    "Only open `## Not tested` entries appear here",
    "**Checks only you can make:**",
    "**Commands to allow:**",
  ]);
  includesAll("plan-execute final report builds on the shared reference", executeReport, [
    `read ${SHARED_REPORT}`,
    "This command runs the checker agent before delivering",
    "## Decisions worth knowing",
    "## Exceptions",
  ]);

  const shared = readPackageFile("plan-suite/skills/plan-write/references/completion-report.md");
  includesAll("shared completion report", shared, [
    "1. **Headline.**",
    "2. **What this plan is for.**",
    "3. **What changed.**",
    "4. **Needs you.**",
    "5. **Record.**",
    "1. What is this plan for?",
    "2. What changed, for a person using it?",
    "3. What must I do or decide?",
    "Allow at most two rewrites, then deliver",
    "**In-session self-check.**",
    "| `/plan-promote`, `/plan-execute`, `/plan-review`, `/plan-close` | Checker agent |",
    "| `/plan-write`, `/plan-archive` | In-session self-check |",
    "Give it only the drafted report",
    "## No unintroduced terms",
    "A change visible in an interface comes with a screenshot or recording",
    "A change to a flow or sequence comes with a before/after diagram",
    "the report says why in one line",
    "## `next_action`",
  ]);

  const close = readSkill("plan-close");
  const order = ["### 1. Run the tests", "### 3. Check the plan against the code", "### 5. Confirm `## Not tested` is clear", "### 6. Confirm a fresh human approval", "### 7. Confirm the work landed", "### 8. Close", "### 9. Stop the worktree's servers", "### 10. Remove the closed worktree"]
    .map((heading) => close.indexOf(heading));
  assert.ok(order.every((at, i) => at > 0 && (i === 0 || at > order[i - 1])), "plan-close: tests, verdict, Not tested, approval, landed, close, stop servers, then cleanup, in that order");
  for (const phrase of [
    "Close from the store's review/ folder",
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
    "`roborepo plans approval <plan> --json`",
    "`roborepo plans close <plan> --json`",
    "direct the user to `/plan-archive`",
    "never as passed",
    "add a missing regression test",
    "rerun the affected checks",
    "This step only confirms",
    "refuse, list them, and send the user to `/plan-review`",
    "Never run a check, check off an entry, or remove one here",
    "canonical linked-worktree server cleanup command",
    "canonical worktree cleanup command scoped to this plan",
    "roborepo git worktrees discard --plan <id> --receipt <receipt> --apply --json",
    "**Discard all listed leftovers and remove**",
    "**Keep worktree**",
    "no backup will be created",
    "legacyRecoveryPending",
    "recorded pending branch retirement",
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

// --- implementation-review: the one rubric, and the callers that use it ---
{
  const rubric = readSkill("implementation-review");
  includesAll("implementation-review", rubric, [
    ...CONVENTION_CHECK_PHRASES,
    ...OUTSIDE_SCOPE_PHRASES,
    ...RISK_CHECKPOINT_PHRASES,
    "a check an agent can run is run, not listed",
    "A reason that does not hold is a `fix` finding",
    "A comment the diff adds that only restates the code | `fix`",
    "| `blocking` |", "| `actionable` |", "| `note` |",
    "| `fix` |", "| `escalate` |", "| `base` |",
    "Size never decides the class",
    "Generic cleanup advice is not a finding",
    "A silent pass is indistinguishable from a skipped one",
    "Functionality gaps", "Naming and intuitiveness", "Project-pattern conformance",
  ]);
  for (const id of ["plan-execute", "plan-review", "plan-close", "session-close"]) {
    const skill = readSkill(id);
    assert.ok(skill.includes("`implementation-review`"), `${id}: references implementation-review`);
    for (const phrase of [...CONVENTION_CHECK_PHRASES, "## Risk Checkpoints", "database schema and migrations"]) {
      assert.ok(!skill.includes(phrase), `${id}: "${phrase}" belongs to implementation-review`);
    }
  }
  includesAll("plan-close review", readSkill("plan-close"), [
    "Then run `implementation-review` over the plan-owned implementation",
    "makes the plan incomplete at the verdict",
    "`test-harness` decides which checks those are",
  ]);
  includesAll("session-close review", readSkill("session-close"), [
    "Run `implementation-review` over the scoped files",
    "are must-fix items in step 5's handoff",
    "Skip this step only if there is no code diff this session",
  ]);
}

// --- plan-suite-init confirms the worktree root once, and reconnects without asking ---
// This gate has no executable code path, so these phrases are its only enforcement.
{
  includesAll("plan-suite-init", readSkill("plan-suite-init"), [
    "~/.worktrees",
    "wait for the user to confirm or override",
    "This is asked once per repository",
    "Leave out `--worktree-root` when the branch already exists",
    "roborepo plans config namespaces <file.json> --json",
    "run `roborepo update`",
  ]);
}

// --- package.config.json loads and validates through the real catalog ---
const catalog = loadPackageCatalog({ includeUnavailable: true });
validatePackageCatalog(catalog);

const byId = new Map(catalog.map((pkg) => [pkg.id, pkg]));
assert.ok(byId.has(PLAN_SUITE_PACKAGE), `catalog missing package: ${PLAN_SUITE_PACKAGE}`);
assert.deepEqual(byId.get(PLAN_SUITE_PACKAGE).requires, ["technical-writing", "implementation-review", "test-harness"], `${PLAN_SUITE_PACKAGE} requires`);
assert.deepEqual(byId.get(PLAN_SUITE_PACKAGE).recommends, ["code-style", "javascript-typescript", "feature-verification"], `${PLAN_SUITE_PACKAGE} recommends`);
assert.deepEqual(byId.get("session-close").requires, ["implementation-review"], "session-close requires");
assert.deepEqual(byId.get("session-close").recommends, ["test-harness", "plan-suite"], "session-close recommends");
const review = byId.get("implementation-review");
assert.equal(review.selectable, false, "implementation-review is dependency-only");
assert.equal(review.presentation.visibility, "dependency", "implementation-review has no Config row");
assert.ok(!review.resources.some((r) => r.type === "slash-command" || (r.entrypoints || []).length), "implementation-review has no slash command");
for (const id of ["plan-suite-init", "plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive"]) {
  assert.ok(!byId.has(id), `${id} is a skill of ${PLAN_SUITE_PACKAGE}, not a package of its own`);
}
assert.deepEqual(
  byId.get(PLAN_SUITE_PACKAGE).resources.filter((r) => r.type === "skill").map((r) => r.id),
  ["plan-suite-init", "plan-write", "plan-promote", "plan-execute", "plan-review", "plan-close", "plan-archive"],
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
assert.match(fs.readFileSync(path.join(repoRoot, "globals/packages", PLAN_SUITE_PACKAGE, "rules.md"), "utf8"), /^## Plan Records Stay Plan-Specific$/m);

// --- generated slash commands exist for every harness and point at the right SKILL.md ---
const slashNames = new Set(loadSlashCommandPlan().commands.map((c) => c.name));
for (const id of Object.keys(SKILLS)) assert.ok(slashNames.has(id), `missing slash command: ${id}`);

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
