// Package-boundary warnings for `roborepo skill audit`.
//
// A package manifest declares which packages it `requires` and `recommends`; each skill's
// `## Paired Skills` table says when it loads a related skill. These checks compare the two and
// flag package shapes that the relationships suggest are wrong. Every result is a warning: the
// author decides whether to merge, split, or add an edge.
//
// Input is plain data, so tests can build fixtures without a catalog on disk:
//   [{ id, requires: [], recommends: [], skills: [{ name, body }] }]

// Rows of a skill's `## Paired Skills` table, read by header so a table with or without the
// Relationship column parses the same way.
export function pairedSkillRows(body) {
  const table = /## Paired Skills\n([\s\S]*?)(?=\n## |$)/.exec(body);
  if (!table) return null;
  const lines = table[1].split("\n").filter((line) => /^\|/.test(line));
  if (lines.length < 2) return [];
  const cells = (line) => line.split("|").slice(1, -1).map((cell) => cell.trim());
  const header = cells(lines[0]).map((cell) => cell.toLowerCase());
  const column = (name) => header.indexOf(name);
  return lines.slice(1)
    .filter((line) => !/^\|\s*-+/.test(line))
    .map((line) => {
      const row = cells(line);
      const at = (name) => (column(name) >= 0 ? row[column(name)] || "" : "");
      return {
        skill: at("skill").replace(/`/g, "").trim(),
        relationship: at("relationship").replace(/`/g, "").trim(),
        when: at("load when"),
      };
    })
    .filter((row) => row.skill);
}

const ALWAYS = /^\**always\**\b/i;

// References a package keeps in prose on purpose, as `source -> target package`. `tighten` names
// the code-convention skills while its own design is still unsettled, so its references are not yet
// relationships. Add an entry only for a reference classified as prose-only, never to silence a
// warning that names a real relationship.
export const PROSE_ONLY_REFERENCES = new Set([
  "tighten -> code-style",
  "tighten -> javascript-typescript",
  "tighten -> react",
]);

// Prose outside the table that tells the reader to load or hand off to `name`.
function proseInstruction(body, name) {
  const outside = body.replace(/## Paired Skills\n[\s\S]*?(?=\n## |$)/, "");
  const escaped = name.replace(/[-/\\^$*+?.()|[\]{}]/g, "\\$&");
  return new RegExp(`\\b(?:load|loads|hand(?:s)? off to|hand it to)\\s+\`/?${escaped}\``, "i").test(outside);
}

// Package ids each package references unconditionally. A table row is unconditional when its
// `Load when` starts with "Always". A prose instruction outside the table counts only when the
// skill's table does not declare that skill: a declared row carries the condition.
function unconditionalTargets(pkg, skillPackage) {
  const targets = new Set();
  for (const skill of pkg.skills) {
    const rows = pairedSkillRows(skill.body) || [];
    const declared = new Set(rows.map((row) => row.skill));
    for (const row of rows) {
      const target = skillPackage.get(row.skill);
      if (target && target !== pkg.id && ALWAYS.test(row.when)) targets.add(target);
    }
    for (const [name, target] of skillPackage) {
      if (target === pkg.id || declared.has(name)) continue;
      if (proseInstruction(skill.body, name)) targets.add(target);
    }
  }
  return targets;
}

export function packageBoundaryFindings(packages, { proseOnly = PROSE_ONLY_REFERENCES } = {}) {
  const findings = [];
  const byId = new Map(packages.map((pkg) => [pkg.id, pkg]));
  const skillPackage = new Map(packages.flatMap((pkg) => pkg.skills.map((skill) => [skill.name, pkg.id])));
  const requires = (a, b) => (byId.get(a)?.requires || []).includes(b);
  const unconditional = new Map(packages.map((pkg) => [pkg.id, unconditionalTargets(pkg, skillPackage)]));

  for (const pkg of packages) {
    for (const target of unconditional.get(pkg.id)) {
      if (proseOnly.has(`${pkg.id} -> ${target}`)) continue;
      if (unconditional.get(target)?.has(pkg.id)) {
        if (pkg.id < target) findings.push(`${pkg.id} and ${target} each unconditionally hand off to the other: merge them`);
        continue;
      }
      if (!requires(pkg.id, target) && !requires(target, pkg.id)) {
        findings.push(`${pkg.id} unconditionally loads ${target}, and neither requires the other: merge them, or add \`requires\``);
      }
    }

    if (pkg.skills.length > 1) {
      const names = pkg.skills.map((skill) => skill.name);
      const linked = pkg.skills.some((skill) =>
        names.some((other) => other !== skill.name && new RegExp(`\`/?${other}\``).test(skill.body)));
      if (!linked) findings.push(`${pkg.id} holds ${names.length} skills and none references another: split them, in a collection if users want them together`);
    }

    const rows = pkg.skills.flatMap((skill) => (pairedSkillRows(skill.body) || []).map((row) => ({ ...row, from: skill.name })));
    const rowTargets = new Map();
    for (const row of rows) {
      const target = skillPackage.get(row.skill);
      if (!target || target === pkg.id || proseOnly.has(`${pkg.id} -> ${target}`)) continue;
      rowTargets.set(target, row);
      const declared = (pkg.requires || []).includes(target) ? "requires" : (pkg.recommends || []).includes(target) ? "recommends" : null;
      if (!declared) {
        findings.push(`${row.from} pairs \`${row.skill}\`, but ${pkg.id} neither requires nor recommends ${target}`);
      } else if (row.relationship && row.relationship !== declared) {
        findings.push(`${row.from} marks \`${row.skill}\` as ${row.relationship}, but ${pkg.id} ${declared} ${target}`);
      }
    }
    for (const kind of ["requires", "recommends"]) {
      for (const target of pkg[kind] || []) {
        if (!rowTargets.has(target)) findings.push(`${pkg.id} ${kind} ${target}, but no ${pkg.id} skill has a Paired Skills row for it`);
      }
    }
  }
  return findings;
}
