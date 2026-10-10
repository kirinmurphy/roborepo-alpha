#!/usr/bin/env node
// Code comments must stand on their own: no comment may cite a plan document, a plan phase or
// milestone, a plan id, or a plan decision. Plans are renamed, rescoped, and closed; a comment that
// points at one goes stale while the code it explains stays. A comment states the reason itself.
//
// Only comments are checked. Plan paths in string literals are behavior — plan-suite reads and
// writes docs/plans, and test fixtures build plan paths — so they are never flagged. Durable docs
// (docs/user, docs/internal) are out of scope: code that serves or audits them names them on purpose.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { commentsFor, lineAt } from "./lib/comment-scan.mjs";

const repoRoot = path.resolve(import.meta.dirname, "..", "..");
const SCANNED_ROOTS = ["bin", "globals", "local", "modules", "portal", "scripts"];
const SKIPPED = /(?:^|\/)vendor\/|^portal\/mockups\//;
const SOURCE_FILE = /\.(?:mjs|cjs|js|sh|bash|ps1|html|css)$/;

const CITATIONS = [
  /docs\/plans\/(?:backlog|active|completed|archived)\//,
  /\b[a-z0-9]+(?:-[a-z0-9]+)*-plan(?:-v\d+)?\.md\b/,
  /\bPhases?\s+\d/,
  /\bMilestone\s+[A-Z0-9]\b/,
  /\bplan\s+(?=[a-z]*\d)[a-z0-9]{6,8}\b/,
  /\bplan decisions?\b|\bper the plan\b|\bthe plan doc\b|\(plan: /i,
];

function citationsIn(filePath, source) {
  const found = [];
  for (const comment of commentsFor(filePath, source)) {
    for (const pattern of CITATIONS) {
      const match = comment.text.match(pattern);
      if (match) found.push({ line: lineAt(source, comment.start + match.index), text: match[0] });
    }
  }
  return found;
}

function scannedFiles() {
  const listed = execFileSync("git", ["ls-files", "--", ...SCANNED_ROOTS], { cwd: repoRoot, encoding: "utf8" });
  return listed.split("\n").filter((file) => {
    if (!file || SKIPPED.test(file)) return false;
    if (SOURCE_FILE.test(file)) return true;
    return file.startsWith("bin/") && fs.existsSync(path.join(repoRoot, file));
  });
}

// --- The scanner tells comments from code in each language it reads. ---
function flags(filePath, source) {
  return citationsIn(filePath, source).map((hit) => `${hit.line}:${hit.text}`);
}

assert.deepEqual(flags("a.mjs", "// See docs/plans/active/x.md\nconst y = 1;\n"), ["1:docs/plans/active/"]);
assert.deepEqual(flags("a.mjs", "const p = \"docs/plans/active/\"; // plain note\n"), [],
  "a plan path in a string literal is behavior, not a citation");
assert.deepEqual(flags("a.mjs", "const t = `// Phase 4 ${x} docs/plans/active/`;\n"), [],
  "template literal text is not a comment");
assert.deepEqual(flags("a.mjs", "const r = /\\/\\/ Phase 4/;\nconst s = 2;\n"), [],
  "a regex literal containing // is not a comment");
assert.deepEqual(flags("a.mjs", "/**\n * Header.\n * Built in Phase 3.\n */\n"), ["3:Phase 3"],
  "a match inside a block comment reports its own line");
assert.deepEqual(flags("a.mjs", "const a = b / c; // per the plan\n"), ["1:per the plan"],
  "division does not swallow a trailing comment");
assert.deepEqual(flags("a.mjs", "// harness-desktop-runtime-discovery.md, plan 3jp3yhtq\n"), ["1:plan 3jp3yhtq"]);
assert.deepEqual(flags("a.mjs", "// the plan summary line lists every plan record\n"), [],
  "plan as a domain noun is not a citation");
assert.deepEqual(flags("a.mjs", "// discoverable-harness-provider-architecture-plan.md\n"),
  ["1:discoverable-harness-provider-architecture-plan.md"]);

assert.deepEqual(flags("a.sh", "# Phase 4 work\necho \"# Phase 4 is text\"\n"), ["1:Phase 4"]);
assert.deepEqual(flags("a.sh", "n=${#arr[@]} # length\n"), [], "${#...} is not a comment");
assert.deepEqual(flags("a.sh", "cat <<EOF\n# Phase 2 heading\nEOF\n# done\n"), [],
  "a heredoc body is data, not a comment");
assert.deepEqual(flags("a.ps1", "<# Phase 7 #>\n$s = \"# Phase 7\"\n"), ["1:Phase 7"]);
assert.deepEqual(flags("a.html", "<!-- see docs/plans/completed/x.md -->\n<p>Phase 1</p>\n"),
  ["1:docs/plans/completed/"]);
assert.deepEqual(flags("a.html", "<script>\n  // Phase 9\n</script>\n<script src=\"x.js\"></script>\n"),
  ["2:Phase 9"], "inline scripts are scanned for comments");
assert.deepEqual(flags("a.css", "a::after { content: \"//\"; } /* Milestone B */\n"), ["1:Milestone B"]);

// --- The repository's own code carries no plan citations. ---
const violations = [];
for (const file of scannedFiles()) {
  const source = fs.readFileSync(path.join(repoRoot, file), "utf8");
  for (const hit of citationsIn(file, source)) violations.push(`${file}:${hit.line}: ${hit.text}`);
}
assert.equal(violations.length, 0,
  `Comments cite plans. State the reason in the comment instead of pointing at a plan:\n  ${violations.join("\n  ")}`);

console.log("ok: no code comment cites a plan document, phase, milestone, id, or decision");
