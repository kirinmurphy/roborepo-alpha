#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
// package.json declares node >=20 and import.meta.dirname only landed in 20.11, so it is undefined
// on a supported floor version. The other 48 modules in this repo derive the directory this way.
import { fileURLToPath } from "node:url";
import { finding, messagesOf, sortBySeverity, FINDING_CODES } from "../../modules/plan-suite/findings.mjs";
import { validateForLifecycle, lifecyclePolicies } from "../../modules/plan-suite/lifecycle-policy.mjs";
import { SECTION_SYNONYMS, SECTION_FINDING_CODES } from "../../modules/plan-suite/section-synonyms.mjs";
import { buildRepairPrompt } from "../../modules/plan-suite/repair-prompt.mjs";
import { parsePlanMarkdown } from "../../modules/plan-suite/index.mjs";
import { classifyPlanId, generatePlanId, isValidPlanId } from "../../modules/plan-suite/plan-id.mjs";
import { validatePlanNaming, readProjectNamespaces, UNIVERSAL_NAMESPACES } from "../../modules/plan-suite/naming.mjs";

// The validation layer is pure — it reads a parsed document and returns findings, touching no
// filesystem — so these drive it directly with in-memory markdown, the same way
// plans-portal-state-check.mjs drives the portal's pure helpers. Filesystem behavior (fresh-disk
// reads, guarded moves) is covered by plan-suite-check.mjs instead.

const PRIORITIES = new Set(["high", "medium", "low", "none"]);
const normalizeHeading = (text) => text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();

testSynonymsAreNormalized();
testSynonymKeysMapToRealCodes();
testEveryEmittedCodeIsCatalogued();
testFindingRejectsUnknownCode();
testMessagesOfProjectsMessages();
testSortBySeverityPutsBlockingFirst();
testBacklogAcceptsDraftReadyAndBlocked();
testBacklogRequiresNextAction();
testActiveReportsEveryProblemTogether();
testActiveAcceptsCompletePlan();
testActiveFlagsEmptyBlockerEntry();
testCompletedReportsEveryProblemTogether();
testCompletedAcceptsFinishedPlan();
testCompletedRejectsBareVerificationHeading();
testArchivedDoesNotRequireCompletion();
testUnclassifiedReportsMisplacementAndStillChecksSections();
testUncheckedTaskCountMatchesRemaining();
testFindingsAreDeterministic();
testValidationDoesNotMutateInput();
testSectionSynonymsAreInterchangeable();
testAcceptedHeadingsTravelOnSectionFindings();
testRepairPromptCarriesIdentityAndLifecycles();
testRepairPromptListsEveryFindingAndResolution();
testRepairPromptCarriesRequiredInstructions();
testRepairPromptLeaksNoAbsolutePath();
testRepairPromptOrdersBlockingFirst();
testRepairPromptListsAcceptedHeadings();
testRepairPromptHandlesMissingPlanId();
testPlanIdClassification();
testGeneratedIdsAreShortFormat();
testNamingIsInertWithoutDeclaredNamespaces();
testNamingAppliesOnlyToNonTerminalLifecycles();
testNamingSkipsNonMarkdownEntries();
testNamingAcceptsUniversalAndProjectNamespaces();
testNamingMatchesLongestHyphenatedNamespace();
testMalformedFilenameReportsShapeOnly();
testForbiddenSuffixesAreReported();
testOrdinalSeriesIsNotMistakenForAVersion();
testNamingFindingsCarryTheirFilename();
testRepositoryPlansProduceNoNamingFindings();
console.log("ok: plan docs findings and lifecycle policy checks passed");

// The tiered id check. Short base36 is the current convention; hyphenated slugs are accepted but
// reported as legacy. Ordering matters — `a3f9c2k1` satisfies the slug pattern too, so a
// slug-first classifier would report every new id as legacy.
function testPlanIdClassification() {
  assert.equal(classifyPlanId("a3f9c2k1"), "short");
  assert.equal(classifyPlanId("kx1qlm"), "short", "six characters is the short lower bound");
  assert.equal(classifyPlanId("harness-parity"), "legacy");
  assert.equal(classifyPlanId("primary-todo"), "legacy");
  assert.equal(classifyPlanId("abcdefghi"), "legacy", "nine characters is past the short bound, so it falls through to the slug rule");

  assert.equal(classifyPlanId(""), "invalid");
  assert.equal(classifyPlanId(undefined), "invalid");
  assert.equal(classifyPlanId("Harness-Parity"), "invalid", "uppercase is rejected by both tiers");
  assert.equal(classifyPlanId("-leading-hyphen"), "invalid");
  assert.equal(classifyPlanId("has spaces"), "invalid");

  assert.equal(isValidPlanId("a3f9c2k1"), true);
  assert.equal(isValidPlanId("harness-parity"), true, "legacy ids stay valid; rewriting one breaks inbound references");
  assert.equal(isValidPlanId("Nope!"), false);
}

function testGeneratedIdsAreShortFormat() {
  const seen = new Set();
  for (let index = 0; index < 200; index += 1) {
    const id = generatePlanId();
    assert.equal(classifyPlanId(id), "short", `generated id must satisfy the current convention: ${id}`);
    seen.add(id);
  }
  assert.ok(seen.size > 190, `generated ids must not collide in a small sample, got ${seen.size} distinct of 200`);
}

// --- helpers ----------------------------------------------------------------------------------

// Builds a plan document from parts so each test states only what it cares about. Defaults
// produce a document that satisfies every universal rule.
function doc({
  frontmatter = "id: sample-plan\npriority: high\n",
  title = "# Sample Plan\n",
  sections = ["Summary", "Goals", "Context", "Proposed Design", "Validation"],
  extra = "",
} = {}) {
  const body = sections.map((name) => `## ${name}\n\nSome real content.\n`).join("\n");
  return parsePlanMarkdown(`---\n${frontmatter}---\n\n${title}\n${body}\n${extra}`, {});
}

function validate(parsed, lifecycle) {
  return validateForLifecycle(parsed, { lifecycle, priorities: PRIORITIES, normalizeHeading });
}

function codesFor(parsed, lifecycle) {
  return validate(parsed, lifecycle).findings.map((item) => item.code);
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

// --- catalog integrity ------------------------------------------------------------------------

// A synonym that isn't already in normalized form would silently never match any heading, which
// is the worst failure mode for a list people hand-edit. Catch it here instead.
function testSynonymsAreNormalized() {
  for (const [section, names] of Object.entries(SECTION_SYNONYMS)) {
    for (const name of names) {
      assert.equal(normalizeHeading(name), name,
        `SECTION_SYNONYMS.${section} entry "${name}" must already be normalized (lowercase, single spaces, no punctuation) or it can never match a heading`);
    }
  }
}

function testSynonymKeysMapToRealCodes() {
  for (const section of Object.keys(SECTION_SYNONYMS)) {
    assert.ok(SECTION_FINDING_CODES[section],
      `every section in SECTION_SYNONYMS needs a finding code; "${section}" has none`);
    assert.ok(FINDING_CODES.includes(SECTION_FINDING_CODES[section]),
      `SECTION_FINDING_CODES.${section} names a code missing from the findings catalog`);
  }
}

// Guards against a validator emitting a code that was renamed or never added to the catalog.
function testEveryEmittedCodeIsCatalogued() {
  const empty = parsePlanMarkdown("no frontmatter, no headings", {});
  for (const lifecycle of [...Object.keys(lifecyclePolicies), "unclassified"]) {
    for (const code of codesFor(empty, lifecycle)) {
      assert.ok(FINDING_CODES.includes(code), `validator emitted uncatalogued finding code: ${code}`);
    }
  }
}

function testFindingRejectsUnknownCode() {
  assert.throws(() => finding("NOT_A_REAL_CODE"), /unknown finding code/,
    "an unknown code must fail loudly rather than producing an undefined-message finding");
}

function testMessagesOfProjectsMessages() {
  const findings = [finding("MISSING_TITLE"), finding("MISSING_ID")];
  assert.deepEqual(messagesOf(findings), ["Missing H1 title.", "Missing frontmatter id."],
    "messagesOf must project exactly the message field, in order");
}

function testSortBySeverityPutsBlockingFirst() {
  const sorted = sortBySeverity([finding("MISSING_TITLE"), finding("MISSING_ID"), finding("MISSING_SUMMARY")]);
  assert.deepEqual(sorted.map((item) => item.code), ["MISSING_ID", "MISSING_TITLE", "MISSING_SUMMARY"],
    "blocking findings lead, and original order is preserved within each severity group");
}

// --- backlog ----------------------------------------------------------------------------------

// Backlog is the resting state for anything not started — proposed, draft, or blocked all belong.
function testBacklogAcceptsDraftReadyAndBlocked() {
  const ready = doc({ frontmatter: "id: p\npriority: high\nnext_action: Do the thing\n" });
  assert.deepEqual(codesFor(ready, "backlog"), [], "a complete backlog plan reports nothing");

  const blocked = doc({ frontmatter: "id: p\npriority: low\nnext_action: Wait\nblocked_by:\n  - other-plan\n" });
  assert.deepEqual(codesFor(blocked, "backlog"), [],
    "a blocked plan is still a valid backlog plan — blockers are not a readiness problem here");

  const unstarted = doc({ frontmatter: "id: p\npriority: none\nnext_action: Decide scope\n" });
  assert.deepEqual(codesFor(unstarted, "backlog"), [], "priority none is a valid backlog state");
}

function testBacklogRequiresNextAction() {
  assert.deepEqual(codesFor(doc(), "backlog"), ["MISSING_NEXT_ACTION"],
    "backlog is actionable, so it needs to say what the next step would be");
}

// --- active -----------------------------------------------------------------------------------

// Every problem is reported in one response, not one field at a time.
function testActiveReportsEveryProblemTogether() {
  const bare = doc({ frontmatter: "id: p\npriority: high\n", sections: ["Summary", "Goals", "Context"] });
  assert.deepEqual(codesFor(bare, "active"), [
    "MISSING_DESIGN",
    "MISSING_CRITERIA",
    "MISSING_NEXT_ACTION",
    "MISSING_IMPLEMENTATION_CONTEXT",
    "MISSING_SUCCESS_CRITERIA",
  ], "all five problems surface together in one pass, universal rules before destination rules");
}

function testActiveAcceptsCompletePlan() {
  const complete = doc({ frontmatter: "id: p\npriority: high\nnext_action: Build it\n" });
  assert.deepEqual(codesFor(complete, "active"), [], "a plan with every section and a next action is active-ready");
}

function testActiveFlagsEmptyBlockerEntry() {
  const parsed = doc({ frontmatter: "id: p\npriority: high\nnext_action: Go\nblocked_by:\n  - real-plan\n" });
  parsed.frontmatter.blocked_by = ["real-plan", "  "];
  const blank = validate(parsed, "active").findings.find((item) => item.code === "EMPTY_BLOCKER_ENTRY");
  assert.ok(blank, "a whitespace-only blocker entry is reported");
  assert.equal(blank.count, 1, "the count reflects how many blocker entries were empty");
}

// --- completed --------------------------------------------------------------------------------

function testCompletedReportsEveryProblemTogether() {
  const unfinished = doc({
    frontmatter: "id: p\npriority: high\nnext_action: Still going\nblocked_by:\n  - other\n",
    extra: "## Work\n\n- [ ] one\n- [ ] two\n- [x] three\n",
  });
  const codes = codesFor(unfinished, "completed");
  for (const expected of ["UNCHECKED_REQUIRED_TASKS", "NEXT_ACTION_REMAINS", "BLOCKERS_REMAIN", "MISSING_VERIFICATION"]) {
    assert.ok(codes.includes(expected), `completed validation must report ${expected} alongside the others`);
  }
}

function testCompletedAcceptsFinishedPlan() {
  const done = doc({
    frontmatter: "id: p\npriority: high\n",
    extra: "## Verification\n\nRan the suite; all green.\n\n## Work\n\n- [x] one\n- [x] two\n",
  });
  assert.deepEqual(codesFor(done, "completed"), [],
    "no unchecked tasks, no next action, no blockers, and real verification content passes");
}

// hasContent is what separates a real section from a heading someone added to silence a warning.
function testCompletedRejectsBareVerificationHeading() {
  const bare = doc({ frontmatter: "id: p\npriority: high\n", extra: "## Verification\n" });
  assert.ok(codesFor(bare, "completed").includes("MISSING_VERIFICATION"),
    "an empty Verification heading does not count as evidence");

  const filled = doc({ frontmatter: "id: p\npriority: high\n", extra: "## Verification\n\nTests pass.\n" });
  assert.ok(!codesFor(filled, "completed").includes("MISSING_VERIFICATION"),
    "a Verification section with content satisfies the requirement");
}

// --- archived ---------------------------------------------------------------------------------

// Archived means terminated or retained for history — deliberately not a claim the work finished.
function testArchivedDoesNotRequireCompletion() {
  const abandoned = doc({
    frontmatter: "id: p\npriority: low\n",
    extra: "## Work\n\n- [ ] never done\n- [ ] also never done\n",
  });
  assert.deepEqual(codesFor(abandoned, "archived"), [],
    "archived accepts unchecked tasks and absent verification — it is not Completed");
}

function testUnclassifiedReportsMisplacementAndStillChecksSections() {
  const codes = codesFor(doc({ sections: ["Summary"] }), "unclassified");
  assert.ok(codes.includes("UNCLASSIFIED_LOCATION"), "a file outside a lifecycle folder is flagged as misplaced");
  assert.ok(codes.includes("MISSING_GOALS"),
    "misplacement is one more finding, not a reason to stop describing the document");
}

// --- metadata and determinism -----------------------------------------------------------------

function testUncheckedTaskCountMatchesRemaining() {
  const parsed = doc({
    frontmatter: "id: p\npriority: high\n",
    extra: "## Verification\n\nDone.\n\n## Work\n\n- [ ] a\n- [ ] b\n- [ ] c\n- [x] d\n",
  });
  const found = validate(parsed, "completed").findings.find((item) => item.code === "UNCHECKED_REQUIRED_TASKS");
  assert.equal(found.count, 3, "count equals the number of unchecked tasks");
  assert.equal(found.count, parsed.taskCounts.remaining, "count is taskCounts.remaining, not recomputed differently");
  assert.deepEqual(found.meta, { remaining: 3, total: 4 }, "metadata carries both remaining and total");
  assert.match(found.message, /unchecked/, "the message describes the problem in plain language");
}

function testFindingsAreDeterministic() {
  const parsed = doc({ frontmatter: "id: p\npriority: high\nnext_action: Go\n", sections: ["Summary"] });
  assert.deepEqual(validate(parsed, "active").findings, validate(parsed, "active").findings,
    "identical input produces deep-equal findings, so codes and metadata are stable across calls");
}

function testValidationDoesNotMutateInput() {
  const parsed = deepFreeze(doc({ sections: ["Summary"] }));
  assert.doesNotThrow(() => validate(parsed, "completed"),
    "validation must not write to the parsed document it was handed");
}

// Every synonym must be genuinely interchangeable — otherwise the list lies about what it accepts.
function testSectionSynonymsAreInterchangeable() {
  for (const [section, names] of Object.entries(SECTION_SYNONYMS)) {
    const code = SECTION_FINDING_CODES[section];
    for (const name of names) {
      const sections = Object.entries(SECTION_SYNONYMS)
        .map(([key, list]) => (key === section ? name : list[0]));
      assert.ok(!codesFor(doc({ sections }), "backlog").includes(code),
        `"${name}" is listed as a ${section} synonym but does not satisfy the ${section} requirement`);
    }
  }
}

// The repair prompt names acceptable headings from this metadata, so it has to be present.
function testAcceptedHeadingsTravelOnSectionFindings() {
  const found = validate(doc({ sections: ["Goals"] }), "backlog").findings
    .find((item) => item.code === "MISSING_SUMMARY");
  assert.deepEqual(found.meta.accepted, SECTION_SYNONYMS.summary,
    "a missing-section finding carries the accepted heading names so the repair prompt can list them");
}

// --- repair prompt ----------------------------------------------------------------------------

// Declared as functions, not consts: the test calls at the top of this file run before module-
// scope const initializers would have evaluated.
function repository() {
  return { name: "sample-repo", id: "abc123" };
}

function planRecord() {
  return { id: "my-plan", title: "My Plan", relativePath: "docs/plans/active/my-plan.md" };
}

function promptFor(parsed, { source = "active", destination = "completed" } = {}) {
  return buildRepairPrompt({
    repository: repository(),
    plan: planRecord(),
    sourceLifecycle: source,
    destinationLifecycle: destination,
    findings: validate(parsed, destination).findings,
  });
}

function blockedDoc() {
  return doc({
    frontmatter: "id: my-plan\npriority: high\nnext_action: Still going\n",
    sections: ["Summary", "Goals", "Context"],
    extra: "## Work\n\n- [ ] one\n- [ ] two\n",
  });
}

function testRepairPromptCarriesIdentityAndLifecycles() {
  const prompt = promptFor(blockedDoc());
  assert.match(prompt, /^\/plan-write\n/, "the prompt opens with the slash command that scopes the work, with no mode");
  assert.ok(prompt.includes("sample-repo"), "the prompt names the repository");
  assert.ok(prompt.includes("my-plan"), "the prompt names the stable plan id");
  assert.ok(prompt.includes("docs/plans/active/my-plan.md"), "the prompt gives the repository-relative path");
  assert.ok(prompt.includes("Current lifecycle: Active"), "the prompt states where the plan is now");
  assert.ok(prompt.includes("Requested lifecycle: Completed"), "the prompt states where it was headed");
}

// The prompt is the only thing the agent sees, so a finding that never made it in is a problem
// the agent cannot know about.
function testRepairPromptListsEveryFindingAndResolution() {
  const parsed = blockedDoc();
  const findings = validate(parsed, "completed").findings;
  const prompt = promptFor(parsed);
  assert.ok(findings.length >= 4, "the fixture must produce several findings for this to be meaningful");
  for (const item of findings) {
    assert.ok(prompt.includes(item.message), `prompt omits the finding message: ${item.code}`);
    assert.ok(prompt.includes(item.resolution), `prompt omits the resolution for: ${item.code}`);
  }
}

function testRepairPromptCarriesRequiredInstructions() {
  const prompt = promptFor(blockedDoc());
  assert.ok(prompt.includes("`/plan-write`"), "instructs the agent to work through /plan-write");
  assert.ok(prompt.includes("Do not move the file"), "instructs the agent not to move the file");
  assert.ok(prompt.includes("docs/plans/active/"), "names the source folder the file must stay in");
  assert.ok(prompt.includes("Preserve the stable plan ID `my-plan`"), "instructs the agent to keep the id stable");
  assert.ok(prompt.includes("`roborepo plans validate docs/plans/active/my-plan.md`"), "instructs the agent to validate its own work");
}

// The record this is built from carries an absolute path internally; the caller strips it, and
// this asserts the stripping actually held, since the prompt gets pasted outside the machine.
function testRepairPromptLeaksNoAbsolutePath() {
  const prompt = buildRepairPrompt({
    repository: { name: "sample-repo" },
    plan: planRecord(),
    sourceLifecycle: "active",
    destinationLifecycle: "completed",
    findings: validate(blockedDoc(), "completed").findings,
  });
  assert.ok(!/\/Users\//.test(prompt), "no home-directory path may appear in a prompt the user pastes elsewhere");
  assert.ok(!/^\s*\//m.test(prompt.replace(/^\/plan-write$/m, "")),
    "no line may start with an absolute filesystem path");
}

function testRepairPromptOrdersBlockingFirst() {
  const prompt = promptFor(blockedDoc());
  const firstProblem = prompt.split("Problems to fix:")[1].trim().split("\n")[0];
  assert.match(firstProblem, /^1\./, "problems are numbered for unambiguous reference");
  assert.ok(!firstProblem.includes("Missing Verification"),
    "advisory findings sort after blocking ones, so Verification is not the lead problem");
}

function testRepairPromptListsAcceptedHeadings() {
  const prompt = promptFor(doc({ frontmatter: "id: my-plan\npriority: high\n", sections: ["Goals"] }),
    { source: "backlog", destination: "active" });
  assert.ok(prompt.includes('Accepted headings: "summary", "purpose", "overview"'),
    "a missing section tells the agent every heading that would satisfy it, not just one example");
}

function testRepairPromptHandlesMissingPlanId() {
  const prompt = buildRepairPrompt({
    repository: repository(),
    plan: { id: "", title: "Untitled Plan", relativePath: "docs/plans/backlog/untitled.md" },
    sourceLifecycle: "backlog",
    destinationLifecycle: "active",
    findings: validate(doc({ frontmatter: "priority: high\n" }), "active").findings,
  });
  assert.ok(prompt.includes("Untitled Plan"), "falls back to the title when there is no id to name the plan by");
  assert.ok(prompt.includes("Add a stable, lowercase-slug plan ID"),
    "asks for an id to be created rather than telling the agent to preserve one that doesn't exist");
  assert.ok(!prompt.includes("Preserve the stable plan ID ``"), "never emits an empty id placeholder");
}

// --- naming -----------------------------------------------------------------------------------

// Naming is the one plan-suite rule that depends on repository configuration rather than on the
// document alone, so these fix both halves of its scope: which repositories it speaks for, and
// which lifecycles inside them.

// A function, not a const, for the reason noted above the repair-prompt helpers: the test calls at
// the top of this file run before module-scope const initializers would have evaluated.
function projectNamespaces() {
  return ["portal", "telemetry", "usage-statusline", "plan-lifecycle"];
}

function namingCodes(filename, lifecycle, namespaces = projectNamespaces()) {
  return validatePlanNaming({ filename, lifecycle, projectNamespaces: namespaces }).map((item) => item.code);
}

// The convention is opt-in. A repository that never declared a vocabulary is not silently held to
// the universal set — otherwise every plan in most repositories reports a finding on first scan.
function testNamingIsInertWithoutDeclaredNamespaces() {
  assert.deepEqual(namingCodes("whatever.md", "backlog", []), [],
    "no declared namespaces means no naming findings at all, not a fallback to the universal set");
  assert.deepEqual(namingCodes("ready-plan-v2.md", "active", []), [],
    "even a filename breaking several rules is silent in an unconfigured repository");
}

// Every non-conforming name in this repository sits in a terminal lifecycle, where renaming would
// break inbound links to settle a convention that no longer governs future work.
function testNamingAppliesOnlyToNonTerminalLifecycles() {
  assert.deepEqual(namingCodes("nonsense.md", "backlog"), ["INVALID_PLAN_FILENAME"]);
  assert.deepEqual(namingCodes("nonsense.md", "active"), ["INVALID_PLAN_FILENAME"]);
  assert.deepEqual(namingCodes("nonsense.md", "completed"), [], "completed names are historical records");
  assert.deepEqual(namingCodes("nonsense.md", "archived"), [], "archived names are historical records");
  assert.deepEqual(namingCodes("nonsense.md", "unclassified"), [],
    "an unclassified file already reports UNCLASSIFIED_LOCATION; its name is not the problem to fix first");
}

// docs/plans legitimately holds .DS_Store, archives, and nested directories. Reporting those as
// malformed plans would be noise the reader has to learn to ignore.
function testNamingSkipsNonMarkdownEntries() {
  for (const entry of [".DS_Store", "roborepo-repository-plans.zip", "roborepo_lifecycle_epic", "notes.txt"]) {
    assert.deepEqual(namingCodes(entry, "backlog"), [], `${entry} is not a plan document and must not be reported as one`);
  }
}

function testNamingAcceptsUniversalAndProjectNamespaces() {
  for (const namespace of UNIVERSAL_NAMESPACES) {
    assert.deepEqual(namingCodes(`${namespace}-some-specific-slug.md`, "backlog"), [],
      `${namespace} is a universal namespace and needs no per-repository declaration`);
  }
  for (const namespace of projectNamespaces()) {
    assert.deepEqual(namingCodes(`${namespace}-some-specific-slug.md`, "backlog"), [],
      `${namespace} is declared by the repository and must be accepted`);
  }
  assert.deepEqual(namingCodes("nosuchdomain-slug.md", "backlog"), ["UNKNOWN_PLAN_NAMESPACE"],
    "an undeclared prefix is how the vocabulary decays, so it is reported");
}

// The bug this pins: reading the prefix as "everything before the first hyphen" rejects every
// hyphenated namespace, and both `usage-statusline` and `plan-lifecycle` are declared here.
function testNamingMatchesLongestHyphenatedNamespace() {
  assert.deepEqual(namingCodes("usage-statusline-codex-parity.md", "backlog"), [],
    "a hyphenated namespace must match as a whole, not be truncated at its first hyphen");
  assert.deepEqual(namingCodes("plan-lifecycle-transitions.md", "backlog"), [],
    "the longer namespace wins over the shorter one it starts with");
  assert.deepEqual(namingCodes("portalized-thing.md", "backlog"), ["UNKNOWN_PLAN_NAMESPACE"],
    "a namespace must be followed by a hyphen; `portal` does not claim `portalized`");
}

// A name with no parseable namespace/slug split has no prefix to check, so reporting a second
// finding about a prefix that was never extracted would describe a value the reader cannot see.
function testMalformedFilenameReportsShapeOnly() {
  assert.deepEqual(namingCodes("singleword.md", "backlog"), ["INVALID_PLAN_FILENAME"],
    "one segment is no namespace at all");
  assert.deepEqual(namingCodes("Portal-Thing.md", "backlog"), ["INVALID_PLAN_FILENAME"],
    "uppercase breaks the lowercase-hyphenated shape");
  assert.deepEqual(namingCodes("portal_thing.md", "backlog"), ["INVALID_PLAN_FILENAME"],
    "underscores are not the separator");
  assert.deepEqual(namingCodes("portal--thing.md", "backlog"), ["INVALID_PLAN_FILENAME"],
    "an empty segment is malformed");
}

// Lifecycle is the folder and status is frontmatter. A filename gets linked to; all of these change.
function testForbiddenSuffixesAreReported() {
  for (const suffix of ["plan", "todo", "active", "completed", "draft", "wip", "final"]) {
    assert.ok(namingCodes(`portal-thing-${suffix}.md`, "backlog").includes("FORBIDDEN_PLAN_FILENAME_SUFFIX"),
      `-${suffix} duplicates something already tracked outside the filename`);
  }
  assert.ok(namingCodes("portal-thing-v2.md", "backlog").includes("FORBIDDEN_PLAN_FILENAME_SUFFIX"),
    "a version suffix belongs in the body if it matters at all");
  assert.ok(namingCodes("portal-thing-2024-01-15.md", "backlog").includes("FORBIDDEN_PLAN_FILENAME_SUFFIX"),
    "a date suffix goes stale the moment the plan is touched");
}

// `<namespace>-<series>-<n>` is the documented shape for a milestone or suite series, so a small
// trailing ordinal must not be read as a version or a year.
function testOrdinalSeriesIsNotMistakenForAVersion() {
  assert.deepEqual(namingCodes("portal-migration-2.md", "backlog"), [],
    "a series ordinal is the documented convention, not a version suffix");
  assert.deepEqual(namingCodes("telemetry-rollout-11.md", "backlog"), []);
}

// The repair prompt quotes findings back to an agent, so a finding that names no filename leaves
// the agent guessing which file to rename.
function testNamingFindingsCarryTheirFilename() {
  const [malformed] = validatePlanNaming({ filename: "singleword.md", lifecycle: "backlog", projectNamespaces: projectNamespaces() });
  assert.equal(malformed.meta.filename, "singleword.md", "the finding names the offending file");
  assert.equal(malformed.kind, "schema");
  assert.equal(malformed.severity, "advisory", "naming never blocks a lifecycle move");

  const [unknown] = validatePlanNaming({ filename: "nosuchdomain-slug.md", lifecycle: "backlog", projectNamespaces: projectNamespaces() });
  assert.equal(unknown.meta.namespace, "nosuchdomain", "the finding quotes the prefix it rejected");
  assert.ok(unknown.meta.allowed.includes("portal"), "the finding lists what would have been accepted");
  assert.ok(unknown.meta.allowed.includes("cli"), "universal namespaces are listed alongside project ones");

  for (const code of ["INVALID_PLAN_FILENAME", "UNKNOWN_PLAN_NAMESPACE", "FORBIDDEN_PLAN_FILENAME_SUFFIX"]) {
    assert.ok(FINDING_CODES.includes(code), `naming emits ${code}, so it must be in the catalog`);
  }
}

// The regression that matters most: this repository declares eleven namespaces and has plans in
// every lifecycle, so a rule that is subtly too strict shows up here as findings on plans that
// were correct all along.
function testRepositoryPlansProduceNoNamingFindings() {
  const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
  const { configured, namespaces } = readProjectNamespaces(repoRoot);
  assert.equal(configured, true, "this repository declares plans-config.json; the fixture depends on it");
  assert.ok(namespaces.length >= 10, `expected the declared vocabulary, got ${namespaces.length} namespaces`);

  const offenders = [];
  for (const lifecycle of ["backlog", "active"]) {
    const dir = path.join(repoRoot, "docs", "plans", lifecycle);
    if (!fs.existsSync(dir)) continue;
    for (const entry of fs.readdirSync(dir)) {
      const codes = namingCodes(entry, lifecycle, namespaces);
      if (codes.length) offenders.push(`${lifecycle}/${entry}: ${codes.join(", ")}`);
    }
  }
  assert.deepEqual(offenders, [],
    "no existing backlog or active plan may gain a naming finding; each line is a false positive to fix in naming.mjs, not a file to rename");
}
