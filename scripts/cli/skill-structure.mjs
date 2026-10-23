import fs from "node:fs";
import path from "node:path";
import { appRoot, isMainModule, workspacePackagesDir, workspaceSkillsDir } from "./roots.mjs";

// Structure limits from Anthropic's skill authoring guidance. They replace per-package token-size
// warnings: a skill body loads once per use, so its size matters less than whether the agent can
// navigate it. The agent may preview a nested reference with a partial read (head -100), so long
// references need a contents section up top, and every reference must be reachable from SKILL.md.
export const SKILL_BODY_MAX_LINES = 500;
export const REFERENCE_TOC_MIN_LINES = 100;
// The contents section has to sit inside the lines a partial read would show.
const TOC_SEARCH_LINES = 40;

function lineCount(text) {
  return text.replace(/\n$/, "").split("\n").length;
}

// The body is everything after the YAML frontmatter, which loads separately as discovery metadata.
function skillBody(text) {
  const match = text.match(/^---\n[\s\S]*?\n---\n?/);
  return match ? text.slice(match[0].length) : text;
}

function hasContentsSection(text) {
  return text
    .split("\n")
    .slice(0, TOC_SEARCH_LINES)
    .some((line) => /^#{2,3}\s+(table of )?contents\s*$/i.test(line.trim()));
}

function referenceFiles(skillDir) {
  const found = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) walk(full);
      else if (entry.name.endsWith(".md") && full !== path.join(skillDir, "SKILL.md")) found.push(full);
    }
  };
  walk(skillDir);
  return found.sort();
}

// Findings for one skill directory: [{ skill, file, rule, message }]. Empty when the skill passes.
export function checkSkillStructure(skillDir) {
  const skillFile = path.join(skillDir, "SKILL.md");
  if (!fs.existsSync(skillFile)) return [];
  const findings = [];
  const skillText = fs.readFileSync(skillFile, "utf8");
  const bodyLines = lineCount(skillBody(skillText));
  if (bodyLines > SKILL_BODY_MAX_LINES) {
    findings.push({
      file: skillFile,
      rule: "skill-body-length",
      message: `SKILL.md body is ${bodyLines} lines; keep it under ${SKILL_BODY_MAX_LINES} and move detail into reference files`,
    });
  }
  for (const reference of referenceFiles(skillDir)) {
    const relative = path.relative(skillDir, reference).split(path.sep).join("/");
    const text = fs.readFileSync(reference, "utf8");
    const lines = lineCount(text);
    if (lines > REFERENCE_TOC_MIN_LINES && !hasContentsSection(text)) {
      findings.push({
        file: reference,
        rule: "reference-contents",
        message: `${relative} is ${lines} lines with no "## Contents" section in its first ${TOC_SEARCH_LINES} lines`,
      });
    }
    if (!skillText.includes(relative)) {
      findings.push({
        file: reference,
        rule: "reference-depth",
        message: `${relative} is not linked from SKILL.md; reference files should be one level deep`,
      });
    }
  }
  return findings.map((finding) => ({ skill: skillDir, ...finding }));
}

// Every directory under root that holds a SKILL.md, sorted.
export function findSkillDirs(root) {
  if (!fs.existsSync(root)) return [];
  const dirs = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) continue;
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "SKILL.md"))) dirs.push(full);
      walk(full);
    }
  };
  walk(root);
  return dirs.sort();
}

// doctor entry point. --built-in checks the skills this checkout ships and exits 1 on any finding;
// --workspace checks the user's own workspace skills and only warns, since those are theirs to fix.
if (isMainModule(import.meta.url)) {
  const builtIn = process.argv.includes("--built-in");
  const roots = builtIn
    ? [path.join(appRoot, "globals"), path.join(appRoot, "local", "skills")]
    : [workspaceSkillsDir, workspacePackagesDir];
  const findings = [...new Set(roots.flatMap(findSkillDirs))].flatMap(checkSkillStructure);
  for (const finding of findings) {
    const where = builtIn ? path.relative(appRoot, finding.skill) : finding.skill;
    console.log(`${builtIn ? "fail" : "warn"}: ${where}: ${finding.message}`);
  }
  if (findings.length === 0) console.log(`ok: ${builtIn ? "built-in" : "workspace"} skill structure`);
  process.exit(builtIn && findings.length > 0 ? 1 : 0);
}
