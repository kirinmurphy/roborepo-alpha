#!/usr/bin/env node
// Characterizes the mode/reference matrices that `technical-writing` and `plan-write` declare in
// their own `SKILL.md` prose.
//
// Why this exists: an agent routes by reading the "For a named mode, read only the needed
// references" list, and a required reference silently dropped from that list is unobservable — the
// work still gets delivered, just without the rule that would have caught the defect. The specific
// failure this pins is `technical-writing write` producing a document without ever loading the
// Creator/Validator loop, because the loop was listed only under `review`.
//
// The prose is the single source of truth on purpose. A machine-readable manifest would be a second
// copy that can drift from the list the agent actually reads, which yields a green test while the
// real skip happens. So this parses the prose, and treats an unparseable matrix as a failure rather
// than as an empty reference set that trivially passes every assertion below.
//
// Scope: this checks what the skills *declare*. Whether a given session actually read a reference is
// a runtime question that skill metadata cannot answer.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");

const TECHNICAL_WRITING = "globals/packages/technical-writing/skills/technical-writing";
const PLAN_WRITE = "globals/packages/plan-write/skills/plan-write";

testMatricesParse();
testWriteModeLoadsTheReviewLoop();
testWriteIsTheOnlyArtifactProducingMode();
testReviewStaysReadOnly();
testCompletionGateIsVisibleFromTheEntryPoint();
testValidatorRuleSetNamesEveryAuthoringReference();
testPlanWriteCreateRequiresSchemaAndNamespaceResolution();
testPlanWriteCreateRunsBothValidationLayers();
testPlanWritePairsTechnicalWritingUnconditionally();
testPlanWriteNamesConditionalPairedSkillsAndTheirTriggers();
testBothSkillsInstructPairedLoadingWithoutBeingAsked();
testEveryReferencedFileExists();
console.log("ok: skill reference matrix characterization passed");

// --- matrix parsing ---------------------------------------------------------------------------

// Reads the "For a named mode, read only the needed references" list and returns
// { mode: [reference paths] }. Modes are the leading `` `name` `` of each top-level bullet;
// references are every `references/<file>.md` mentioned on that bullet, including its continuation
// lines. Only the explicit "Always read" bullet folds into every mode. Other non-mode bullets are
// conditional — "Portal-generated prompts: read `references/prompt-contracts.md` when prompt shape
// matters" applies to a situation, not to every mode — so treating them as universal would assert a
// requirement the SKILL.md never states, and a later edit narrowing one could not be detected.
function parseReferenceMatrix(skillRelativePath) {
  const content = read(path.join(skillRelativePath, "SKILL.md"));
  // technical-writing routes by named mode; plan-write takes no mode, so it routes by situation.
  // Both lists share one bullet shape.
  const section = /(?:For a named mode, read only the needed references|Read the references for the situation):\n([\s\S]*?)\n\n/.exec(content);
  assert.ok(section, `${skillRelativePath}/SKILL.md no longer contains a parseable mode/reference list — if the wording changed deliberately, update this parser; do not delete the assertion`);

  const bullets = section[1].split(/\n(?=- )/).map((bullet) => bullet.replace(/\s+/g, " ").trim()).filter(Boolean);
  assert.ok(bullets.length >= 2, `${skillRelativePath}: expected several mode bullets, parsed ${bullets.length}`);

  const matrix = {};
  const universal = [];
  for (const bullet of bullets) {
    const references = [...bullet.matchAll(/references\/[a-z0-9-]+\.md/g)].map((match) => match[0]);
    const mode = /^- `([a-z-]+)`[:,]/.exec(bullet);
    if (mode) matrix[mode[1]] = references;
    else if (/^- Always read\b/i.test(bullet)) universal.push(...references);
  }

  assert.ok(Object.keys(matrix).length >= 2,
    `${skillRelativePath}: parsed no named modes from the reference list — the bullet shape changed and the matrix is now invisible to this test`);
  for (const mode of Object.keys(matrix)) matrix[mode] = [...new Set([...matrix[mode], ...universal])];
  return matrix;
}

function read(relativePath) {
  return fs.readFileSync(path.join(repoRoot, relativePath), "utf8").replace(/\r\n/g, "\n");
}

// Prose in these files is hard-wrapped, so any sentence-level assertion has to be made against a
// whitespace-collapsed copy. Otherwise a reflow that changes nothing about the meaning breaks the
// test, and the fix people reach for is deleting the assertion.
function flat(relativePath) {
  return read(relativePath).replace(/\s+/g, " ");
}

// A matrix that parses to nothing would make every assertion below vacuously true, so the shape is
// pinned before anything is asserted about its contents.
function testMatricesParse() {
  const writing = parseReferenceMatrix(TECHNICAL_WRITING);
  assert.ok(writing.write, "technical-writing must declare a `write` mode");
  assert.ok(writing.review, "technical-writing must declare a `review` mode");
  assert.ok(writing.write.length >= 4, `\`write\` parsed only ${writing.write.length} references; the list shape likely changed`);

  // plan-write is one atomic command: it creates or updates, and every other lifecycle step is its
  // own suite command, so none of the retired modes may reappear as a situation here.
  const plans = parseReferenceMatrix(PLAN_WRITE);
  for (const situation of ["create", "update"]) {
    assert.ok(plans[situation], `plan-write must declare a \`${situation}\` situation`);
  }
  for (const retired of ["next", "start", "sync", "validate", "review", "handoff"]) {
    assert.ok(!plans[retired], `plan-write must not route a \`${retired}\` mode; that step is its own command or CLI`);
  }
  assert.match(flat(`${PLAN_WRITE}/SKILL.md`), /`\/plan-write` takes no mode/, "plan-write must say it takes no mode argument");
}

// --- technical-writing ------------------------------------------------------------------------

// The core regression. `write` is the artifact-producing mode, so the reference defining the
// completion loop has to be reachable from it — a mandatory finishing step that lives only under
// another mode is a step the artifact-producing path never has to take.
function testWriteModeLoadsTheReviewLoop() {
  const matrix = parseReferenceMatrix(TECHNICAL_WRITING);
  assert.ok(matrix.write.includes("references/review-loop.md"),
    "`technical-writing write` must require references/review-loop.md; without it an agent can follow the documented reference list literally and still deliver an unvalidated document");
  for (const required of ["references/doc-shapes.md", "references/section-guidance.md", "references/representation.md", "references/anti-patterns.md"]) {
    assert.ok(matrix.write.includes(required), `\`write\` must keep requiring ${required}`);
  }
}

// Create, edit, revise, restructure, and update are all `write`. Splitting them into more entry
// points makes mode selection harder without adding a workflow distinction, and a mode nobody
// selects is a mode whose gates never run.
function testWriteIsTheOnlyArtifactProducingMode() {
  const matrix = parseReferenceMatrix(TECHNICAL_WRITING);
  for (const absent of ["edit", "revise", "update", "restructure"]) {
    assert.ok(!matrix[absent], `technical-writing must not declare a separate \`${absent}\` mode; those are forms of \`write\``);
  }
  const content = flat(`${TECHNICAL_WRITING}/SKILL.md`);
  assert.match(content, /creating, editing, revising, restructuring, and updating a durable document are all `write`/i,
    "SKILL.md must state that edit/revise-shaped requests resolve to `write`");
}

// `review` reports and stops. If it ever implies mutation, the read-only half of the
// Creator/Validator separation collapses and the validator starts grading its own rewrite.
function testReviewStaysReadOnly() {
  const content = flat(`${TECHNICAL_WRITING}/SKILL.md`);
  assert.match(content, /`review` evaluates an existing document and reports violations without changing it/,
    "SKILL.md must define `review` as read-only");
  const loop = flat(`${TECHNICAL_WRITING}/references/review-loop.md`);
  assert.match(loop, /\*\*Validator\*\* — does not write/, "the Validator role must stay explicitly non-writing");
  assert.match(loop, /Its only output is a report of violations/, "the Validator's only output is a report");
}

// The gate has to be visible at the entry point, before any reference is opened. That is the whole
// convention: references provide depth, SKILL.md provides gates.
function testCompletionGateIsVisibleFromTheEntryPoint() {
  const content = flat(`${TECHNICAL_WRITING}/SKILL.md`);
  assert.match(content, /## Completion Gate/, "SKILL.md must carry a completion gate section");
  assert.match(content, /Do not present a durable document as finished until the Creator\/Validator loop/,
    "the gate must state the condition that makes completion invalid");
  assert.match(content, /10-pass cap/, "the gate must name the loop's termination condition, not just its success condition");
  assert.match(content, /surfaced to the user/, "the gate must require each pass to be observable");
}

// The scope mismatch this fixes: `write` authored documents under representation.md, but the
// Validator's rule list omitted it — so a document could be authored under a rule nobody checked.
function testValidatorRuleSetNamesEveryAuthoringReference() {
  const loop = read(`${TECHNICAL_WRITING}/references/review-loop.md`);
  const authoring = parseReferenceMatrix(TECHNICAL_WRITING).write
    .filter((reference) => reference !== "references/review-loop.md")
    .map((reference) => path.basename(reference));
  for (const reference of authoring) {
    assert.ok(loop.includes(reference),
      `review-loop.md must name ${reference} in the Validator's applicable rule set; \`write\` authors under it, so leaving it out means authoring against a rule the Validator never checks`);
  }
  assert.match(loop, /## Applicable rule set/, "the Validator's rule set must be an explicit, resolvable list");
  assert.match(loop, /paired skill/i, "the rule set must say how paired implementation skills contribute constraints");
}

// --- plan-write ---------------------------------------------------------------------------------

function testPlanWriteCreateRequiresSchemaAndNamespaceResolution() {
  const matrix = parseReferenceMatrix(PLAN_WRITE);
  for (const required of ["references/plan-schema.md", "references/workflow-create.md", "references/writing-guidelines.md"]) {
    assert.ok(matrix.create.includes(required), `\`plan-write create\` must require ${required}`);
  }
  // Creation ends in validation, so the mode producing the plan has to reach the reference that
  // says how the plan is checked — the same reachability rule `write`/review-loop.md follows.
  assert.ok(matrix.create.includes("references/workflow-validate.md"),
    "`plan-write create` must require references/workflow-validate.md; a completion check parked behind another mode is one the creation path never has to run");

  const skill = flat(`${PLAN_WRITE}/SKILL.md`);
  assert.match(skill, /## Creation Gates/, "plan-write SKILL.md must carry creation gates at the entry point");
  assert.match(skill, /Resolve the plan identity before drafting body content/,
    "the identity checkpoint must be visible before any reference is opened");
  assert.match(skill, /plans-config\.json/, "the entry point must name the namespace source file");
  assert.match(skill, /docs\/plans\/backlog\//, "the entry point must state that creation lands in backlog");

  const create = flat(`${PLAN_WRITE}/references/workflow-create.md`);
  assert.match(create, /Identity checkpoint/, "the create workflow must have a pre-draft identity checkpoint");
  assert.match(create, /before drafting/i, "the checkpoint must be ordered before drafting, not after");
  for (const decision of ["Namespace", "Filename", "H1"]) {
    assert.ok(create.includes(decision), `the identity checkpoint must resolve ${decision}`);
  }
}

// A plan is both a lifecycle artifact and a durable document, and the two validators own different
// things. Either one alone can pass a plan the other would reject.
function testPlanWriteCreateRunsBothValidationLayers() {
  const create = flat(`${PLAN_WRITE}/references/workflow-create.md`);
  assert.match(create, /technical-writing/, "the create workflow must invoke the technical-writing Validator");
  assert.match(create, /review-loop\.md/, "the create workflow must point at the Validator contract by path");
  assert.match(create, /workflow-validate\.md|plan-write. validation/,
    "the create workflow must invoke deterministic plan-write validation");
  assert.match(create, /both layers/,
    "the create workflow must state that a revision is rechecked by both layers, not just the one that reported");
  assert.match(create, /hand off to `\/plan-start` only after the backlog artifact passes both layers/,
    "a requested start must be sequenced after the backlog artifact passes, and must name the command that performs it");

  const validate = flat(`${PLAN_WRITE}/references/workflow-validate.md`);
  assert.match(validate, /Naming:/, "the validate workflow must list the naming checks the domain now enforces");
  assert.match(validate, /plans-config\.json/, "naming validation reads declared namespaces from the config");
  assert.match(validate, /backlog. and .active/,
    "the validate workflow must state that naming findings are scoped to non-terminal lifecycles");
  assert.match(validate, /roborepo plans validate/, "deterministic findings come from the CLI, not prose the skill re-derives");
  assert.match(validate, /Repository consistency/, "the judgment half the CLI cannot make stays in the workflow");
}

// --- paired skills ------------------------------------------------------------------------------

// Both skills state the pairing as an instruction, and neither makes it conditional on the user
// having named the skill. A rule that only fires when asked for is a rule the user is enforcing by
// hand, which is the thing being removed.
function testBothSkillsInstructPairedLoadingWithoutBeingAsked() {
  for (const skill of [PLAN_WRITE, TECHNICAL_WRITING]) {
    const content = flat(`${skill}/SKILL.md`);
    assert.match(content, /## Paired Skills/, `${skill} must declare paired skills at the entry point`);
    assert.match(content, /do not wait to be asked for them by name/,
      `${skill} must instruct paired loading rather than describe a relationship`);
  }
  const loop = flat(`${TECHNICAL_WRITING}/references/review-loop.md`);
  assert.doesNotMatch(loop, /When the user requested them, or when/,
    "the Validator's paired-skill trigger must not lead with an explicit user request; that reintroduces the dependence on being asked");
  assert.match(loop, /an explicit request is one trigger, not the only one/,
    "material relevance is the trigger; a request is one way to reach it");
}

// The behavior this pins: a user should not have to name `technical-writing` on every plan request
// for it to be loaded. Prose that merely observes the two skills are related ("pair with
// technical-writing") reads as background, not as an instruction, and background does not get
// followed — so the requirement has to be stated as one, and stated at the entry point.
function testPlanWritePairsTechnicalWritingUnconditionally() {
  const skill = flat(`${PLAN_WRITE}/SKILL.md`);
  assert.match(skill, /## Paired Skills/, "plan-write must declare its paired skills at the entry point");
  assert.match(skill, /Load these as part of the work; do not wait to be asked for them by name/,
    "the paired-skill list must instruct loading rather than describe a relationship");
  assert.match(skill, /`technical-writing` \| \*\*Always\*\*/,
    "technical-writing is unconditional: every plan is prose someone reads later");
  assert.match(skill, /Load `technical-writing` before drafting, without being asked/,
    "the creation gates must repeat the requirement, so skipping it is visibly noncompliant before any reference is opened");
}

// Conditional skills need their trigger written down. "Load when relevant" defers the judgment back
// to the reader and is why these get skipped.
function testPlanWriteNamesConditionalPairedSkillsAndTheirTriggers() {
  const skill = flat(`${PLAN_WRITE}/SKILL.md`);
  for (const [paired, trigger] of [
    ["code-style", /module boundaries/],
    ["javascript-typescript", /ESM, exports, types/],
    ["test-harness", /tests, verification commands, or a regression strategy/],
  ]) {
    assert.ok(skill.includes(`\`${paired}\``), `plan-write must name ${paired} as a paired skill`);
    assert.match(skill, trigger, `${paired} must carry a concrete load condition, not "when relevant"`);
  }
  assert.match(skill, /subject matter, never plan size|not on how large the plan is/,
    "plan size is not the trigger; a short plan that specifies module placement still needs code-style");
  assert.match(skill, /State which paired skills/,
    "loaded skills must be reported, or a skipped one is indistinguishable from one that did not apply");
}

// --- reachability -------------------------------------------------------------------------------

// A matrix entry pointing at a file that does not exist routes an agent to nothing, and the failure
// is silent: the reference simply cannot be read.
function testEveryReferencedFileExists() {
  for (const skill of [TECHNICAL_WRITING, PLAN_WRITE]) {
    for (const [mode, references] of Object.entries(parseReferenceMatrix(skill))) {
      for (const reference of references) {
        const full = path.join(repoRoot, skill, reference);
        assert.ok(fs.existsSync(full), `${skill} \`${mode}\` requires ${reference}, which does not exist`);
      }
    }
  }
}
