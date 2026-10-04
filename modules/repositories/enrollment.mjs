import path from "node:path";
import { realpathOf } from "./identity.mjs";

// Enrollment answers "which features has the user enabled for this repository?" — distinct from
// discovery (registry membership) and from capabilities (data exists / can be queried). A repo can
// be discovered, resolved, and active while every domain enrollment stays disabled.

export function isEnrolled(record, domain) {
  return record?.enrollments?.[domain]?.enabled === true;
}

export function enrollmentSourceId(record, domain) {
  return record?.enrollments?.[domain]?.sourceId ?? null;
}

// Does an existing Plans discovery root cover `repoRoot`? A source covers a repo when the repo root
// is the source itself or a descendant of it. Returns the covering source path or null.
// `discoveryRoots` are absolute, already-normalized source paths (plan-suite settings.discoveryRoots).
export function plansSourceCoverage(repoRoot, discoveryRoots) {
  if (typeof repoRoot !== "string" || !repoRoot) return null;
  // Realpath both sides so a source and repo that are the same directory reached via different
  // symlink paths still match (otherwise enrollment would wrongly add a duplicate source). Returns
  // the ORIGINAL source string (what Plans stores), not its realpath.
  const target = realpathOf(path.resolve(repoRoot));
  for (const root of discoveryRoots || []) {
    const source = realpathOf(path.resolve(root));
    if (target === source || isDescendant(source, target)) return root;
  }
  return null;
}

function isDescendant(parent, child) {
  const rel = path.relative(parent, child);
  return Boolean(rel) && !rel.startsWith("..") && !path.isAbsolute(rel);
}

// Given a repo root and existing Plans sources, decide the enrollment action WITHOUT mutating
// anything (pure planning step; the CLI bridge performs the actual write + refresh in Phase 3).
//   { covered: true,  coveringSource }                      -> refresh registry, add no source
//   { covered: false, suggestedSource: <exact repo root> }  -> add exact root as narrow default
// Never suggests a parent directory; broadening is an explicit user choice at the call site.
export function planPlansEnrollment(repoRoot, discoveryRoots) {
  const coveringSource = plansSourceCoverage(repoRoot, discoveryRoots);
  if (coveringSource) return { covered: true, coveringSource };
  return { covered: false, suggestedSource: path.resolve(repoRoot) };
}
