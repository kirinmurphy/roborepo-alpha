import fs from "node:fs";
import path from "node:path";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { loadSkillTriggerFixtures } from "./skill-trigger-fixtures.mjs";

function parseDescription(content) {
  const match = /^---\n([\s\S]*?)\n---/.exec(content);
  if (!match) return "";
  const lines = match[1].split("\n");
  for (let i = 0; i < lines.length; i += 1) {
    const line = lines[i];
    const inline = /^description:\s*(.+)$/.exec(line);
    if (inline && inline[1] !== ">") return inline[1].replace(/^["']|["']$/g, "").trim();
    if (/^description:\s*>$/.test(line)) {
      const block = [];
      while (i + 1 < lines.length && /^(?:\s{2,}|\t)/.test(lines[i + 1])) {
        i += 1;
        block.push(lines[i].replace(/^(?:\s{2}|\t)/, ""));
      }
      return block.join(" ").trim();
    }
  }
  return "";
}

function readDescription(skill) {
  return parseDescription(fs.readFileSync(path.join(packageSkillSources().get(skill), "SKILL.md"), "utf8"));
}

function normalized(value) {
  return String(value).toLowerCase();
}

function includesAny(text, phrases) {
  const haystack = normalized(text);
  return phrases.some((phrase) => haystack.includes(normalized(phrase)));
}

function checkTriggerCase(test) {
  const failures = [];
  const sourceSkills = packageSkillSources();
  if (!sourceSkills.has(test.skill)) {
    return [`${test.skill}: no shared skill source found`];
  }

  const description = readDescription(test.skill);
  const missingTriggers = (test.triggerPhrases || []).filter((phrase) => !includesAny(description, [phrase]));
  const missingSkips = (test.skipPhrases || []).filter((phrase) => !includesAny(description, [phrase]));
  if (missingTriggers.length) failures.push(`${test.skill}: description missing trigger phrase(s): ${missingTriggers.join(", ")}`);
  if (missingSkips.length) failures.push(`${test.skill}: description missing skip phrase(s): ${missingSkips.join(", ")}`);

  for (const prompt of test.match || []) {
    if (!includesAny(prompt, test.triggerPhrases || [])) {
      failures.push(`${test.skill}: match prompt lacks a trigger phrase: ${prompt}`);
    }
  }
  for (const prompt of test.nearMiss || []) {
    if (includesAny(prompt, test.triggerPhrases || [])) {
      failures.push(`${test.skill}: near-miss prompt contains trigger phrase: ${prompt}`);
    }
  }
  return failures;
}

function packageSkillSources() {
  const sources = new Map();
  for (const pkg of loadPackageCatalog({ includeUnavailable: true })) {
    for (const resource of pkg.resources || []) {
      if (resource.type === "skill") sources.set(resource.id, path.join(pkg.sourceRoot, resource.source));
    }
  }
  return sources;
}

export function skillTriggerCheck(args = []) {
  const invalid = args.filter((arg) => arg !== "--check" && arg !== "--quiet" && arg !== "-q");
  if (invalid.length) {
    console.error("usage: roborepo skill triggers [--check] [--quiet|-q]");
    process.exit(2);
  }
  const quiet = args.includes("--quiet") || args.includes("-q");
  let fixtures;
  try {
    fixtures = loadSkillTriggerFixtures();
  } catch (error) {
    console.error(`fail: ${error.message}`);
    process.exit(1);
  }
  const failures = [];
  for (const test of fixtures) failures.push(...checkTriggerCase(test));

  if (failures.length) {
    for (const failure of failures) console.error(`fail: ${failure}`);
    process.exit(1);
  }
  if (!quiet) console.log(`ok: ${fixtures.length} skill trigger fixture(s)`);
}
