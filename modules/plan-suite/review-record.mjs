// The `## Review` record /plan-review keeps in a plan: findings as checkboxes under `### Findings`,
// and separate review-result and human-approval fields. Verification prose remains free form.
//
// Pure: reads the headings and tasks parsePlanMarkdown already found, plus the body's lines.

const APPROVAL_FIELDS = {
  decision: "Decision",
  commit: "Reviewed implementation commit",
  confirmedBy: "Confirmed by",
};

const RESULT_FIELDS = {
  status: "Status",
  commit: "Reviewed implementation commit",
  baseCommit: "Base commit",
};

// `headings` and `tasks` carry 1-based body line numbers.
// Review results and approvals are independent: a complete review can still await human approval.
export function reviewRecord(headings, tasks, lines) {
  const review = headings.find((heading) => heading.depth === 2 && heading.text.toLowerCase() === "review");
  if (!review) return { present: false, findings: { open: 0, total: 0 }, result: null, approval: null };
  const end = sectionEnd(headings, review, lines.length);
  const subsection = (name) => headings.find((heading) => heading.line > review.line && heading.line < end
    && heading.depth === 3 && heading.text.toLowerCase() === name);

  const findingsHeading = subsection("findings");
  const findings = findingsHeading
    ? tasks.filter((task) => task.line > findingsHeading.line && task.line < sectionEnd(headings, findingsHeading, lines.length))
    : [];

  const resultHeading = subsection("result");
  let result = null;
  if (resultHeading) {
    const body = lines.slice(resultHeading.line, sectionEnd(headings, resultHeading, lines.length) - 1);
    result = Object.fromEntries(Object.entries(RESULT_FIELDS).map(([key, label]) => [key, field(body, label).toLowerCase()]));
  }

  const approvalHeading = subsection("approval");
  let approval = null;
  if (approvalHeading) {
    const body = lines.slice(approvalHeading.line, sectionEnd(headings, approvalHeading, lines.length) - 1);
    approval = Object.fromEntries(Object.entries(APPROVAL_FIELDS).map(([key, label]) => [key, field(body, label)]));
    approval.decision = approval.decision.toLowerCase();
    approval.commit = approval.commit.toLowerCase();
  }
  return {
    present: true,
    findings: { open: findings.filter((task) => !task.done).length, total: findings.length },
    result,
    approval,
  };
}

// The line after a section's last line: the next heading at the same or a shallower depth, or EOF.
function sectionEnd(headings, start, lineCount) {
  return headings.find((heading) => heading.line > start.line && heading.depth <= start.depth)?.line ?? lineCount + 1;
}

function field(lines, label) {
  const pattern = new RegExp(`^\\s*[-*]\\s+${label}:\\s*(.*?)\\s*$`, "i");
  const match = lines.map((line) => pattern.exec(line)).find(Boolean);
  return match ? match[1].replace(/^`|`$/g, "") : "";
}
