// Destination readiness policy: what a plan document must look like to belong in each lifecycle
// folder. One validator per destination, selected from a declarative map, so adding a lifecycle
// state means adding an entry here rather than extending a conditional inside the move logic.
//
// Everything in this module is pure — it reads a parsed document descriptor and returns findings.
// It never touches the filesystem and never mutates its input, which is what lets the same code
// run from the scanner (deriving plan.readiness), from movePlanLifecycle (gating a move), and
// from the tests, with no divergence between them.
//
// Universal rules run for every destination. Per-destination rules run on top. Backlog and
// Archived add almost nothing, which is the intent: they are resting states, not claims about
// the work being ready or finished.
import { finding } from "./findings.mjs";
import { SECTION_SYNONYMS, SECTION_FINDING_CODES } from "./section-synonyms.mjs";

// Adapts a parsed document into the small read-only surface the validators need, so each
// validator reads as a list of requirements rather than a tangle of optional chaining.
export function describeDocument(parsed, { normalizeHeading }) {
  const headingNames = new Set(parsed.headings.map((h) => normalizeHeading(h.text)));
  return {
    title: parsed.title,
    frontmatter: parsed.frontmatter,
    taskCounts: parsed.taskCounts,
    notTested: parsed.notTested || { present: false, entries: [], unchecked: 0 },
    has: (section) => SECTION_SYNONYMS[section].some((name) => headingNames.has(name)),
    // Presence alone isn't evidence — a bare heading with nothing under it (before the next
    // heading or EOF) doesn't count as having real content.
    hasContent: (...names) =>
      parsed.headings.some((h) => names.includes(normalizeHeading(h.text)) && h.hasContent),
  };
}

function missingSection(section) {
  return finding(SECTION_FINDING_CODES[section], { meta: { accepted: SECTION_SYNONYMS[section] } });
}

// Applies to every destination: the frontmatter contract plus the sections that make a plan
// document legible at all.
function universalFindings(doc, { lifecycle, priorities }) {
  const findings = [];
  if (!doc.title) findings.push(finding("MISSING_TITLE"));
  if (!doc.frontmatter.id) findings.push(finding("MISSING_ID"));
  if (!doc.frontmatter.priority) findings.push(finding("MISSING_PRIORITY"));
  if (doc.frontmatter.priority && !priorities.has(doc.frontmatter.priority)) {
    findings.push(finding("INVALID_PRIORITY", { meta: { value: doc.frontmatter.priority } }));
  }
  // A file outside any lifecycle folder is misplaced, but still gets every section check below —
  // the misplacement is one more finding, not a reason to stop describing the document.
  if (!lifecyclePolicies[lifecycle]) findings.push(finding("UNCLASSIFIED_LOCATION"));
  for (const section of ["summary", "goals", "context", "design", "criteria"]) {
    if (!doc.has(section)) findings.push(missingSection(section));
  }
  return findings;
}

// Built work no test covers stays a finding until someone confirms it by hand. Active plans carry
// these while work continues; /plan-close refuses to complete a plan while any remain.
function notTestedFindings(doc) {
  const { unchecked } = doc.notTested;
  return unchecked > 0 ? [finding("UNCONFIRMED_NOT_TESTED", { count: unchecked })] : [];
}

// Backlog holds anything not yet started: proposed, draft, blocked, or ready. The only extra
// requirement is knowing what the next step would be.
function validateBacklog(doc) {
  const findings = [];
  if (!doc.frontmatter.next_action) findings.push(finding("MISSING_NEXT_ACTION"));
  return findings;
}

// Active means someone can pick this up and work it now, so the plan needs a next step, an
// approach, a definition of done, and blockers that actually name something.
function validateActive(doc) {
  const findings = [];
  if (!doc.frontmatter.next_action) findings.push(finding("MISSING_NEXT_ACTION"));
  if (!doc.has("design")) {
    findings.push(finding("MISSING_IMPLEMENTATION_CONTEXT", { meta: { accepted: SECTION_SYNONYMS.design } }));
  }
  if (!doc.has("criteria")) {
    findings.push(finding("MISSING_SUCCESS_CRITERIA", { meta: { accepted: SECTION_SYNONYMS.criteria } }));
  }
  const blockers = doc.frontmatter.blocked_by || [];
  const empty = blockers.filter((item) => !item || !item.trim());
  if (empty.length) findings.push(finding("EMPTY_BLOCKER_ENTRY", { count: empty.length }));
  findings.push(...notTestedFindings(doc));
  return findings;
}

// Completed asserts the work is finished, so nothing may remain outstanding: no unchecked tasks,
// no next action, no blockers, and some record of how it was verified.
function validateCompleted(doc) {
  const findings = [];
  const { remaining, total } = doc.taskCounts;
  if (remaining > 0) findings.push(finding("UNCHECKED_REQUIRED_TASKS", { count: remaining, meta: { remaining, total } }));
  if (doc.frontmatter.next_action) {
    findings.push(finding("NEXT_ACTION_REMAINS", { meta: { value: doc.frontmatter.next_action } }));
  }
  const blockers = doc.frontmatter.blocked_by || [];
  if (blockers.length) findings.push(finding("BLOCKERS_REMAIN", { count: blockers.length, meta: { blockers } }));
  if (!doc.hasContent("verification")) findings.push(finding("MISSING_VERIFICATION"));
  findings.push(...notTestedFindings(doc));
  return findings;
}

// Archived is explicit termination or historical retention — deliberately not a claim that the
// work finished, so it requires none of Completed's evidence. It only objects to a plan still
// advertising a next action, which would contradict being archived.
function validateArchived(doc) {
  const findings = [];
  if (doc.frontmatter.next_action) {
    findings.push(finding("ARCHIVED_NEXT_ACTION", { meta: { value: doc.frontmatter.next_action } }));
  }
  return findings;
}

// The destination-policy map. A lifecycle absent from this map (notably "unclassified") gets the
// universal rules only — it has no destination contract of its own because it isn't a place a
// plan is ever deliberately moved to.
export const lifecyclePolicies = {
  backlog: validateBacklog,
  active: validateActive,
  completed: validateCompleted,
  archived: validateArchived,
};

// The single entry point. Returns findings for `lifecycle`, universal rules first, then that
// destination's own. `ready` drives both the scanner's readiness chip and the move gate.
export function validateForLifecycle(parsed, { lifecycle, priorities, normalizeHeading }) {
  const doc = describeDocument(parsed, { normalizeHeading });
  const policy = lifecyclePolicies[lifecycle];
  const findings = [
    ...universalFindings(doc, { lifecycle, priorities }),
    ...(policy ? policy(doc) : []),
  ];
  return { ready: findings.length === 0, findings };
}
