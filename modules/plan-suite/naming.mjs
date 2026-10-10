// Deterministic filename and namespace validation for plan documents.
//
// The naming convention — `<namespace>-<slug>.md`, lowercase and hyphenated, no lifecycle or date
// suffix — is otherwise enforced only by the authoring agent's memory. This module is the
// machine-checkable half: given a
// path and a repository's declared namespaces, it returns the same structured findings every other
// plan-suite rule produces, so the portal, the CLI, and the repair prompt all describe a bad
// filename with one wording.
//
// Scope is deliberately narrow, along two axes:
//
//   - Lifecycle. Findings apply to `backlog` and `active` only. Every non-conforming filename in
//     this repository sits in `completed/`, and a plan in a terminal lifecycle is a historical
//     record: renaming it would break inbound links to settle a convention that no longer governs
//     any future work.
//   - Opt-in. A repository with no declared namespaces in `plans-config.json` gets no findings at
//     all. The universal namespaces are a fallback rather than a default, and holding a repository to a vocabulary it never declared would flag every plan it has.
//
// What this module does NOT judge: whether the chosen namespace is the *best* fit, or whether the
// slug reads well. Those need judgment about intent. It checks only what a rule can prove.
import fs from "node:fs";
import path from "node:path";
import { finding } from "./findings.mjs";

// Namespaces that apply to most software projects and need no per-repository declaration.
export const UNIVERSAL_NAMESPACES = Object.freeze([
  "cli", "git", "infra", "os", "test", "docs", "security", "perf",
]);

// Lifecycles whose filenames are still governed by the convention. Terminal lifecycles are exempt.
const VALIDATED_LIFECYCLES = new Set(["backlog", "active"]);

// Suffixes that encode something already tracked elsewhere: lifecycle is the folder, priority and
// blockers are frontmatter, and a version belongs in the plan body if it matters at all. A filename
// gets linked to; all of these change.
const FORBIDDEN_SUFFIXES = [
  "plan", "todo", "followup", "followups", "backlog", "active", "completed", "complete",
  "archived", "draft", "wip", "new", "old", "final",
];

// A trailing `-v2`, `-2024`, `-2024-01-15`, or `-20240115`.
const VERSION_SUFFIX = /-v\d+$/;
const DATE_SUFFIX = /-\d{4}(-\d{2}){0,2}$/;

// `<namespace>-<slug>`: at least two hyphen-separated lowercase alphanumeric segments. A single
// segment has no namespace at all, which is the case this catches most often.
const STEM_PATTERN = /^[a-z0-9]+(-[a-z0-9]+)+$/;

export const PLANS_CONFIG_RELATIVE_PATH = "docs/plans/plans-config.json";

// Cached per repository root and invalidated on the config file's own mtime, matching the plan
// record cache's contract: edits are always picked up, but a scan of hundreds of plans reads and
// parses the config once rather than once per file.
const configCache = new Map();

// Reads a repository's declared project namespaces. A repository without the file is not an error —
// most repositories will not have one — so this reports `configured: false` and lets the caller
// decide. Malformed JSON is treated the same way: naming validation is advisory, and failing a
// whole scan over an unparseable config would be a worse outcome than not enforcing the rule.
export function readProjectNamespaces(repositoryRoot) {
  const file = path.join(repositoryRoot, "docs", "plans", "plans-config.json");
  let stat;
  try {
    stat = fs.statSync(file);
  } catch {
    configCache.delete(file);
    return { configured: false, namespaces: [] };
  }
  const cached = configCache.get(file);
  if (cached && cached.mtimeMs === stat.mtimeMs) return cached.value;

  let value = { configured: false, namespaces: [] };
  try {
    const data = JSON.parse(fs.readFileSync(file, "utf8"));
    const names = data && typeof data.namespaces === "object" && data.namespaces
      ? Object.keys(data.namespaces).filter((name) => typeof name === "string" && name.trim())
      : [];
    value = { configured: true, namespaces: names.map((name) => name.trim()) };
  } catch {
    value = { configured: false, namespaces: [] };
  }
  configCache.set(file, { mtimeMs: stat.mtimeMs, value });
  return value;
}

// The pure core: everything filesystem-dependent is resolved by the caller and handed in, so the
// same evaluation runs from the scanner, from tests with synthetic namespace lists, and from any
// future consumer without needing a real repository on disk.
//
// `filename` is the basename with extension. `lifecycle` is the folder-derived lifecycle.
// `projectNamespaces` is the list of keys declared in `plans-config.json`.
//
// An empty namespace list means the repository has not declared a vocabulary, and the convention is
// deliberately inert there. The universal namespaces are a fallback rather than a default, and a
// repository without a config should be asked for one
// rather than silently held to a convention it never adopted — enforcing shape anyway would flag
// every plan in most repositories, which is noise rather than a finding.
export function validatePlanNaming({ filename, lifecycle, projectNamespaces = [] }) {
  if (!projectNamespaces.length) return [];
  if (!VALIDATED_LIFECYCLES.has(lifecycle)) return [];
  // Non-Markdown entries are not plans. `docs/plans` legitimately holds `.DS_Store`, archives, and
  // nested directories; reporting those as malformed plans would be noise, not a finding.
  if (typeof filename !== "string" || !filename.endsWith(".md")) return [];

  const stem = filename.slice(0, -3);
  const findings = [];

  if (!STEM_PATTERN.test(stem)) {
    findings.push(finding("INVALID_PLAN_FILENAME", { meta: { filename } }));
    // Without a parseable `<namespace>-<slug>` shape there is no prefix to check against the
    // namespace list, so stop here rather than emitting a second finding about a prefix that
    // was never really extracted.
    return findings;
  }

  const suffix = forbiddenSuffix(stem);
  if (suffix) {
    findings.push(finding("FORBIDDEN_PLAN_FILENAME_SUFFIX", { meta: { filename, suffix } }));
  }

  const allowed = [...UNIVERSAL_NAMESPACES, ...projectNamespaces];
  if (!matchNamespace(stem, allowed)) {
    findings.push(finding("UNKNOWN_PLAN_NAMESPACE", {
      meta: { filename, namespace: stem.slice(0, stem.indexOf("-")), allowed: [...allowed].sort() },
    }));
  }

  return findings;
}

// Namespaces may themselves contain hyphens — `usage-statusline` and `plan-lifecycle` are both
// declared in this repository — so the prefix cannot be read as "everything before the first
// hyphen". Match the longest declared namespace the stem actually starts with, and require a
// hyphen after it so `plan` never claims `plan-lifecycle-foo.md` out from under the more specific
// namespace, and `perf` never matches `performance-budget.md`.
function matchNamespace(stem, allowed) {
  return [...allowed]
    .sort((a, b) => b.length - a.length)
    .find((namespace) => stem.startsWith(`${namespace}-`)) || "";
}

// Names which prohibited suffix a stem carries, or "" when it carries none. Returned rather than a
// boolean so the finding can quote the offending segment back to the reader.
function forbiddenSuffix(stem) {
  const last = stem.slice(stem.lastIndexOf("-") + 1);
  if (FORBIDDEN_SUFFIXES.includes(last)) return last;
  if (VERSION_SUFFIX.test(stem)) return `v${last.replace(/^v/, "")}`;
  // Quote the whole date rather than the segment after the final hyphen: `-2024-01-15` must report
  // "2024-01-15", not the bare "15" a reader cannot act on.
  const date = DATE_SUFFIX.exec(stem);
  if (date) return date[0].slice(1);
  return "";
}
