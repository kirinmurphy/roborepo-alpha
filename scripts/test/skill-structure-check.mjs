#!/usr/bin/env node
// skill-structure.mjs rules, against throwaway fixture skills: SKILL.md body length, a contents
// section in long references, and references linked directly from SKILL.md.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  checkSkillStructure,
  findSkillDirs,
  REFERENCE_TOC_MIN_LINES,
  SKILL_BODY_MAX_LINES,
} from "../cli/skill-structure.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-skill-structure-"));
const lines = (count, prefix = "line") => Array.from({ length: count }, (_, i) => `${prefix} ${i + 1}`).join("\n") + "\n";

function skill(name, body, references = {}) {
  const dir = path.join(root, name);
  fs.mkdirSync(path.join(dir, "references"), { recursive: true });
  fs.writeFileSync(path.join(dir, "SKILL.md"), `---\nname: ${name}\ndescription: fixture\n---\n${body}`);
  for (const [file, text] of Object.entries(references)) fs.writeFileSync(path.join(dir, file), text);
  return dir;
}
const rules = (dir) => checkSkillStructure(dir).map((finding) => finding.rule).sort();

try {
  const longReference = `# Long\n\n## Contents\n- One\n\n${lines(REFERENCE_TOC_MIN_LINES)}`;
  const passing = skill("passing", "Read `references/long.md`.\n", { "references/long.md": longReference });
  assert.deepEqual(rules(passing), [], "a linked long reference with a contents section passes");

  const longBody = skill("long-body", lines(SKILL_BODY_MAX_LINES + 1));
  assert.deepEqual(rules(longBody), ["skill-body-length"], "a body over the limit is reported");
  const atLimit = skill("at-limit", lines(SKILL_BODY_MAX_LINES));
  assert.deepEqual(rules(atLimit), [], "frontmatter does not count toward the body limit");

  const noContents = skill("no-contents", "See `references/long.md`.\n", {
    "references/long.md": `# Long\n\n${lines(REFERENCE_TOC_MIN_LINES)}`,
  });
  assert.deepEqual(rules(noContents), ["reference-contents"], "a long reference without contents is reported");

  const lateContents = skill("late-contents", "See `references/long.md`.\n", {
    "references/long.md": `# Long\n\n${lines(60)}## Contents\n${lines(60)}`,
  });
  assert.deepEqual(rules(lateContents), ["reference-contents"], "contents beyond a partial read do not count");

  const shortReference = skill("short-reference", "See `references/short.md`.\n", {
    "references/short.md": lines(REFERENCE_TOC_MIN_LINES - 1),
  });
  assert.deepEqual(rules(shortReference), [], "a short reference needs no contents section");

  const nested = skill("nested", "See `references/first.md`.\n", {
    "references/first.md": "Then read `references/second.md`.\n",
    "references/second.md": "Details.\n",
  });
  const nestedFindings = checkSkillStructure(nested);
  assert.deepEqual(nestedFindings.map((f) => f.rule), ["reference-depth"], "a reference reachable only through another is reported");
  assert.match(nestedFindings[0].message, /references\/second\.md/);
  assert.equal(nestedFindings[0].skill, nested, "findings name their skill directory");

  assert.ok(findSkillDirs(root).includes(passing), "findSkillDirs lists every directory holding a SKILL.md");
  assert.deepEqual(findSkillDirs(path.join(root, "missing")), [], "a missing root yields no skills");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

console.log("skill-structure ok");
