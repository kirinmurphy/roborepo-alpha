// Which heading labels satisfy each required plan section. Validation matches headings by
// normalized label (lowercased, punctuation collapsed to single spaces — see normalizeHeading in
// index.mjs), so a section counts as "present" only when its heading text appears in one of these
// lists.
//
// TO ADD A SYNONYM: add the normalized label to the right array. Lowercase, single spaces between
// words, no punctuation. That is the whole change — nothing else needs updating. The lists are
// also what the generated repair prompt reads to tell an agent which headings are acceptable, so
// there is no second copy to keep in sync.
//
// Adding a synonym loosens matching: documents using that label stop reporting the section as
// missing. Removing one tightens it and may surface new warnings on existing documents. Neither
// can block a lifecycle move — the destination gate is advisory and "Move anyway" is always
// available — so changes here are display-only and safe to iterate on.
//
// After editing, run: node scripts/test/plan-suite-findings-check.mjs

export const SECTION_SYNONYMS = {
  summary: ["summary", "purpose", "overview"],
  goals: ["goals", "goal", "desired outcome", "desired outcomes"],
  context: ["current state", "context", "current behavior", "background"],
  design: [
    "proposed design", "implementation plan", "implementation",
    "implementation checklist", "implementation sequence", "implementation phases",
    "proposed behavior",
  ],
  criteria: ["validation", "acceptance criteria", "success criteria", "exit criteria"],
};

// Which finding each section reports when absent. Kept beside the synonyms so adding a section
// means touching one file.
export const SECTION_FINDING_CODES = {
  summary: "MISSING_SUMMARY",
  goals: "MISSING_GOALS",
  context: "MISSING_CONTEXT",
  design: "MISSING_DESIGN",
  criteria: "MISSING_CRITERIA",
};
