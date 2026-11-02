#!/usr/bin/env node
import assert from "node:assert/strict";
import { deriveSessionFindings } from "../cli/telemetry-session-findings.mjs";

// Session warning prose is returned to the drill-down API; every supported warning must render
// without relying on another finding branch having run first.
const cases = [
  {
    type: "large_document_read",
    severity: "warn",
    summary: "Loaded a very large document straight into context — 12k tokens across 2 reads.",
  },
  {
    type: "repeated_document_read",
    severity: "high",
    summary: "Re-read the same large document 1 time — 12k tokens spent re-reading content already in context.",
  },
  {
    type: "unrecognized_warning",
    severity: "high",
    summary: "Large or repeated document reads added 12k tokens of context.",
  },
];

for (const { type, severity, summary } of cases) {
  const findings = deriveSessionFindings({
    sessionId: "session-with-read-warning",
    read_warnings: [{ type, approx_tokens: 12_000, read_count: 2, hint: "Read a smaller section." }],
  });
  assert.deepEqual(findings, [{
    kind: "session_read_warning",
    severity,
    summary,
    detail: "1 instance · 12k approx tokens · 2 total reads",
    hint: "Read a smaller section.",
    section_key: "reads",
  }], type);
}

console.log("telemetry session findings checks passed");
