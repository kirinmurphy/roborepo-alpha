import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveProjectIdentity, canonicalRepositoryId, providerUrlForRepositoryId } from "../repositories/index.mjs";
import { finding, messagesOf } from "./findings.mjs";
import { validateForLifecycle } from "./lifecycle-policy.mjs";
import { buildRepairPrompt } from "./repair-prompt.mjs";
import { classifyPlanId, isExternalBlocker } from "./plan-id.mjs";
import { validatePlanNaming, readProjectNamespaces } from "./naming.mjs";
import { renderMarkdown } from "../../scripts/cli/markdown-render.mjs";

export const LIFECYCLES = new Set(["backlog", "active", "completed", "archived"]);
export const PRIORITIES = new Set(["high", "medium", "low", "none"]);
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_PLANS_PER_REPO = 500;

// Per-file record cache keyed by absolute path. Each entry is invalidated the moment a file's own
// mtime changes, so edits are always picked up — this only skips the expensive re-parse + git
// shell-outs (readPlanRecord) for files that haven't changed since the last scan. Directory
// listing still runs on every call (cheap `readdirSync`), so new/removed files are always seen.
const planRecordCache = new Map();

// Plans scans the repositories RoboRepo knows about (pljvmyh §9); the scan lives beside this module.
export { buildPlanSnapshot } from "./canonical-scan.mjs";

// Appends each plan's cross-plan findings to a copy of its validation. Records come from
// planRecordCache, so mutating `plan.validation` in place would stack the same relationship
// findings onto the cached record again on every rescan of a long-running portal.
export function withRelationshipFindings(plans) {
  const relationships = relationshipFindings(plans);
  return plans.map((record) => {
    const findings = [...record.plan.validation.findings, ...(relationships.get(record.key) || [])];
    const validation = { valid: findings.length === 0, findings, warnings: messagesOf(findings) };
    return { ...record, plan: { ...record.plan, validation } };
  });
}

// Every plan in the one repository containing `cwd`, validated exactly as the portal validates it.
// Unlike discovery, a linked worktree is a valid root here: a suite skill running inside the
// worktree that implements a plan validates that worktree's copy of the plans.
export function buildRepositoryPlanSnapshot({ cwd = process.cwd() } = {}) {
  const root = findPlansRoot(path.resolve(cwd));
  if (!root) {
    throw domainError("PLAN_NOT_FOUND", "No repository with docs/plans contains this directory.", {
      resolution: "Run the command inside a repository that has a docs/plans folder.",
    });
  }
  const repository = repositoryRecord(fs.realpathSync(root));
  const plans = withRelationshipFindings(discoverPlansInRepository(repository));
  return { repository: publicRepository(repository), root: repository.root, plans };
}

// Resolves `selector` — a plan id, or a plan path relative to the repository root, the current
// directory, or absolute — to one record of a repository snapshot.
export function selectRepositoryPlan(snapshot, selector, { cwd = process.cwd() } = {}) {
  const byId = snapshot.plans.filter((record) => record.plan.id && record.plan.id === selector);
  if (byId.length === 1) return byId[0];
  const candidates = [path.resolve(snapshot.root, selector), path.resolve(cwd, selector)];
  const byPath = snapshot.plans.find((record) => candidates.some((candidate) => samePath(candidate, record.absolutePath)));
  if (byPath) return byPath;
  if (byId.length > 1) {
    throw domainError("INVALID_CHANGE", `More than one plan has id ${selector}.`, {
      resolution: "Pass the plan's repository-relative path instead.",
      details: byId.map((record) => record.plan.relativePath),
    });
  }
  throw domainError("PLAN_NOT_FOUND", `No plan matches ${selector}.`, {
    resolution: "Pass a plan id or a docs/plans/... path in this repository.",
  });
}

// The deterministic document findings for one plan, or every plan, in the repository containing
// `cwd`. This is the result `roborepo plans validate` prints; the model-driven checks a suite skill
// runs against code and docs are separate, and a clean result here is not evidence they ran.
export function validateRepositoryPlans({ cwd = process.cwd(), selector = null } = {}) {
  const snapshot = buildRepositoryPlanSnapshot({ cwd });
  const records = selector ? [selectRepositoryPlan(snapshot, selector, { cwd })] : snapshot.plans;
  const plans = records.map((record) => ({
    id: record.plan.id,
    relativePath: record.plan.relativePath,
    lifecycle: record.plan.lifecycle,
    findings: record.plan.validation.findings,
  }));
  const findings = plans.flatMap((plan) => plan.findings);
  return {
    repository: { name: snapshot.repository.name, repositoryId: snapshot.repository.repositoryId },
    plans,
    summary: {
      plans: plans.length,
      findings: findings.length,
      blocking: findings.filter((item) => item.severity === "blocking").length,
    },
  };
}

function findPlansRoot(start) {
  for (let current = start; ; current = path.dirname(current)) {
    if (fs.existsSync(path.join(current, "docs", "plans")) || fs.existsSync(path.join(current, ".git"))) return current;
    if (path.dirname(current) === current) return null;
  }
}

function samePath(a, b) {
  try {
    return fs.realpathSync(a) === fs.realpathSync(b);
  } catch {
    return false;
  }
}

export function findPlanByKey(snapshot, key) {
  const plan = snapshot.plans.find((item) => item.key === key);
  if (!plan) throw new Error("unknown plan key");
  return plan;
}

// Stable-identity lookup: plan `id` (frontmatter) survives a lifecycle move even though `key`
// (hashed from repo root + relative path) does not. `id` uniqueness is only enforced within a
// single repository (see relationshipFindings' `${repository.id}:${plan.id}` dedup key), so a
// `repositoryId` is required to disambiguate when the same id could exist in two repos. An empty
// id ("" — the buildPlanRecord fallback for plans with no frontmatter id) never matches.
export function findPlanById(snapshot, id, repositoryId) {
  if (!id) return null;
  return snapshot.plans.find((item) => item.plan.id === id && (!repositoryId || item.repository.id === repositoryId)) || null;
}

// Builds a structured domain error every mutation throw site uses, so the CLI/route layer has one
// shape to serialize instead of pattern-matching ad hoc `.code` properties.
export function domainError(code, message, { resolution, details, findings, repair, status } = {}) {
  const err = new Error(message);
  err.code = code;
  if (resolution !== undefined) err.resolution = resolution;
  if (details !== undefined) err.details = details;
  // Structured findings and the generated repair prompt ride along on readiness failures. Both
  // must also be listed in portal-routes-plans' sendDomainError and portalPostJson, which
  // whitelist error keys explicitly.
  if (findings !== undefined) err.findings = findings;
  if (repair !== undefined) err.repair = repair;
  err.status = status ?? DOMAIN_ERROR_STATUS[code] ?? 400;
  return err;
}

const DOMAIN_ERROR_STATUS = {
  INVALID_CHANGE: 400,
  STALE_PLAN: 409,
  DESTINATION_EXISTS: 409,
  LIFECYCLE_REQUIREMENTS: 422,
  PLAN_NOT_FOUND: 404,
  MOVE_FAILED: 500,
};

// Two-stage resolution shared by every mutation: locate the record the client expects by `key`
// first (the common case — nothing has moved), then re-resolve by stable `id` when the key no
// longer exists, since a lifecycle move changes `key` but not `id`. Throws PLAN_NOT_FOUND only
// when neither resolves.
function resolvePlanForMutation(snapshot, { id, key, repositoryId }) {
  const byKey = snapshot.plans.find((item) => item.key === key);
  if (byKey) return byKey;
  const byId = findPlanById(snapshot, id, repositoryId);
  if (byId) return byId;
  throw domainError("PLAN_NOT_FOUND", "This plan can no longer be found. Refresh and try again, or restore the file if it was deleted.");
}

// Validates the resolved record still matches what the client last saw. A key/lifecycle/path
// mismatch while the stable id still resolves means the file moved since the client loaded it
// (report where it is now); a straight mtime/field mismatch means it was edited in place.
// `expectedField`/`expectedValue` is the generic form any mutated scalar property can use
// (see updatePlanField); expectedLifecycle/expectedPriority stay as named params since
// movePlanLifecycle and updatePlanPriority's public contracts already key off those exact names.
function assertExpectedState(record, { key, expectedLifecycle, expectedPriority, expectedField, expectedValue, mtimeMs }) {
  const mismatches = [];
  if (key !== undefined && record.key !== key) mismatches.push(`moved to ${record.plan.relativePath}`);
  if (expectedLifecycle !== undefined && record.plan.lifecycle !== expectedLifecycle) mismatches.push(`lifecycle is now ${record.plan.lifecycle}`);
  if (expectedPriority !== undefined && record.plan.priority !== expectedPriority) mismatches.push(`priority is now ${record.plan.priority}`);
  if (expectedField !== undefined && record.plan[expectedField] !== expectedValue) mismatches.push(`${expectedField} is now ${record.plan[expectedField]}`);
  if (mtimeMs !== undefined && record.mtimeMs !== mtimeMs) mismatches.push("file changed on disk");
  if (mismatches.length === 0) return;
  throw domainError("STALE_PLAN", "This plan changed outside the portal, so the update wasn't applied.", {
    resolution: "The page will refresh to show the current state.",
    details: [...mismatches, `current lifecycle: ${record.plan.lifecycle}`, `current path: ${record.plan.relativePath}`],
  });
}

export function readPlanDocument(snapshot, key) {
  const publicRecord = findPlanByKey(snapshot, key);
  if (!publicRecord.absolutePath) throw new Error("plan file path unavailable");
  const repoRoot = publicRecord.repository.root;
  const realRepo = fs.realpathSync(repoRoot);
  const realFile = fs.realpathSync(publicRecord.absolutePath);
  if (!inside(realRepo, realFile)) throw new Error("plan file escaped repository boundary");
  const stat = fs.statSync(realFile);
  const tooLarge = stat.size > MAX_DOC_BYTES;
  const markdown = tooLarge ? "" : fs.readFileSync(realFile, "utf8");
  const parsed = tooLarge ? null : parsePlanMarkdown(markdown, {
    repository: stripRepositoryRoot(publicRecord.repository),
    relativePath: publicRecord.plan.relativePath,
  });
  return {
    plan: stripPrivatePath(publicRecord),
    markdown,
    // The shared renderer (scripts/cli/markdown-render.mjs -- also backing Config's skill popup and
    // the Telemetry guide) replaced a private mini-renderer here that had no tables, mermaid,
    // ordered lists, blockquotes, links, or horizontal rules. Frontmatter is stripped first: it is
    // plan metadata already rendered as structured drawer fields, not body prose.
    html: tooLarge
      ? "<p>Document is over 1 MiB and was not rendered.</p>"
      : renderMarkdown(parseFrontmatter(markdown).body),
    parsed,
  };
}

// The suite commands a portal prompt may open with. Each takes no mode argument; anything else
// (including no command at all) yields a context-only prompt with no slash line.
export const PLAN_SUITE_COMMANDS = new Set(["plan-write", "plan-promote", "plan-start", "plan-close"]);

export function buildPrompt(command, selectedPlans, { mode = "repository-aware" } = {}) {
  const commandLines = PLAN_SUITE_COMMANDS.has(command) ? [`/${command}`, ""] : [];
  const plans = selectedPlans.map((record) => record.plan ? record : stripPrivatePath(record));
  if (mode === "portable") {
    return [
      ...commandLines,
      "Use this bounded portable plan context. Request more repository context when needed.",
      "",
      ...plans.map((item) => portablePlanSummary(item)),
    ].join("\n");
  }
  return [
    ...commandLines,
    ...plans.map((item) => `Work with plan \`${item.plan.id || item.plan.title}\` at \`${item.plan.relativePath}\` in repository \`${item.repository.name}\`.`),
    "",
    "Verify material claims against the current repository before changing lifecycle or marking work complete.",
  ].join("\n");
}

// `canonical` carries the registry's identity when the scan comes from a known repository. Every
// checkout of that repository then shares one `id`, so plans from a worktree group, filter, and
// resolve relationships with the main checkout's plans; `root` stays the checkout the record was
// read from, which is where its edits are written.
export function repositoryRecord(root, canonical = null) {
  const git = gitInfo(root);
  const repositoryId = canonical?.repositoryId ?? canonicalRepositoryId(resolveProjectIdentity(root, "plan-suite"));
  return {
    id: stableKey(canonical?.repositoryId ?? root),
    repositoryId,
    name: canonical?.name ?? path.basename(root),
    root,
    providerUrl: providerUrlForRepositoryId(repositoryId),
    gitHead: git.head,
    branch: git.branch,
    gitAvailable: git.available,
  };
}

export function discoverPlansInRepository(repository) {
  const { files, scoped } = planFilesInRepository(repository);
  return files.map((absolutePath) => readPlanRecord(scoped, absolutePath));
}

// The plan files in one checkout, without reading them, plus the repository record carrying that
// walk's `truncated`/`errors`. Split from discoverPlansInRepository so a scan can decide which files
// deserve a full record — building one costs several Git subprocesses.
export function planFilesInRepository(repository) {
  const plansDir = path.join(repository.root, "docs", "plans");
  const files = [];
  const errors = [];
  let truncated = false;
  walkPlans(plansDir, repository.root, files, errors);
  files.sort();
  if (files.length > MAX_PLANS_PER_REPO) {
    files.length = MAX_PLANS_PER_REPO;
    truncated = true;
  }
  return { files, scoped: { ...repository, truncated, errors } };
}

function walkPlans(dir, repoRoot, files, errors) {
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (err) {
    if (err?.code !== "ENOENT") errors.push({ path: relative(repoRoot, dir), error: String(err?.message || err) });
    return;
  }
  for (const entry of entries) {
    if (entry.name.startsWith(".") || entry.name.endsWith("~") || entry.name.endsWith(".swp")) continue;
    const full = path.join(dir, entry.name);
    let real;
    try { real = fs.realpathSync(full); } catch { continue; }
    if (!inside(repoRoot, real)) continue;
    if (entry.isDirectory()) {
      walkPlans(full, repoRoot, files, errors);
      continue;
    }
    if (entry.isFile() && entry.name.endsWith(".md")) files.push(full);
  }
}

export function readPlanRecord(repository, absolutePath) {
  const relativePath = relative(repository.root, absolutePath);
  const stat = fs.statSync(absolutePath);
  // Naming findings depend on the repository's declared namespaces, not only on the plan file, so
  // a cached record built under a different namespace set is stale even when the plan itself is
  // untouched. Editing plans-config.json must re-validate every plan in the repository.
  const namespaces = readProjectNamespaces(repository.root).namespaces;
  const namespaceKey = namespaces.join(",");
  const cached = planRecordCache.get(absolutePath);
  if (
    cached
    && cached.mtimeMs === stat.mtimeMs
    && cached.repositoryRoot === repository.root
    && cached.namespaceKey === namespaceKey
  ) {
    // Repository-level fields (truncated/errors) can change between scans even when the file
    // itself hasn't, so refresh those on the cached record instead of trusting them blindly.
    return { ...cached.record, repository };
  }
  const record = buildPlanRecord(repository, absolutePath, relativePath, stat, namespaces);
  planRecordCache.set(absolutePath, { mtimeMs: stat.mtimeMs, repositoryRoot: repository.root, namespaceKey, record });
  return record;
}

function buildPlanRecord(repository, absolutePath, relativePath, stat, projectNamespaces = []) {
  const tooLarge = stat.size > MAX_DOC_BYTES;
  const markdown = tooLarge ? "" : fs.readFileSync(absolutePath, "utf8");
  const parsed = tooLarge ? emptyParsed("DOCUMENT_TOO_LARGE") : parsePlanMarkdown(markdown, { repository, relativePath });
  const lifecycle = lifecycleFromPath(relativePath);
  const git = gitFileInfo(repository.root, relativePath, parsed.frontmatter.reviewed_commit);
  const validation = validateParsedPlan(parsed, {
    lifecycle,
    filename: path.basename(relativePath),
    projectNamespaces,
  });
  const findings = [...parsed.findings, ...validation.findings];
  if (tooLarge) findings.push(finding("DOCUMENT_TOO_LARGE_TO_RENDER"));
  const warnings = messagesOf(findings);
  return {
    key: stableKey(`${repository.root}:${relativePath}`),
    absolutePath,
    mtimeMs: stat.mtimeMs,
    repository,
    plan: {
      id: parsed.frontmatter.id || "",
      title: parsed.title || path.basename(relativePath, ".md"),
      relativePath,
      lifecycle,
      readiness: validation.ready ? "ready" : "draft",
      priority: parsed.frontmatter.priority || "none",
      nextAction: parsed.frontmatter.next_action || "",
      blockers: parsed.frontmatter.blocked_by || [],
      dependencies: parsed.frontmatter.depends_on || [],
      related: parsed.frontmatter.related || [],
      reviewedCommit: parsed.frontmatter.reviewed_commit || "",
      // Git's administrative name for the one linked worktree implementing this plan (see
      // plan-schema.md). Empty means unassociated; Home joins it to Runtime's git.worktreeName.
      worktree: typeof parsed.frontmatter.worktree === "string" ? parsed.frontmatter.worktree.trim() : "",
      reviewState: git.reviewState,
      modifiedAt: stat.mtime.toISOString(),
      gitLastChangedAt: git.lastChangedAt,
      gitStatus: git.status,
      taskCounts: parsed.taskCounts,
      // Open task text, carried in the list snapshot for active plans only. The all-open-tasks
      // dialog needs every active plan's remaining items at once; per-plan document fetches would
      // be one round trip per card. Scoped to active because that is the only lifecycle the dialog
      // covers, and shipping all 47 plans' tasks would roughly triple this field's cost (~68KB vs
      // ~23KB measured) to serve a view that never reads the rest. Completed items are excluded —
      // taskCounts already carries the totals the progress bar needs.
      openTasks: lifecycle === "active" ? parsed.tasks.filter((task) => !task.done) : [],
      headings: parsed.headings,
      excerpt: excerpt(markdown),
      // `warnings` is the display-string projection of `findings`, derived here so the two can
      // never drift. Existing consumers (search corpus, health filter, card badge, drawer list,
      // portable prompt summary) read the strings; the dialog and repair prompt read the findings.
      validation: { valid: findings.length === 0, findings, warnings },
    },
  };
}

export function parsePlanMarkdown(markdown, context = {}) {
  const { frontmatter, body, warnings, findings } = parseFrontmatter(markdown);
  const lines = body.split("\n");
  const headings = [];
  const tasks = [];
  let title = "";
  // Lines inside a fenced code block are example text, not plan structure: a sample `## Not tested`
  // section or `- [ ]` checkbox in a fence must never become a real section or an open task.
  let fence = null;
  lines.forEach((line, index) => {
    const marker = /^\s{0,3}(`{3,}|~{3,})/.exec(line);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      return;
    }
    if (fence) return;
    const h = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (h) {
      const heading = { depth: h[1].length, text: h[2].trim(), line: index + 1 };
      headings.push(heading);
      if (!title && heading.depth === 1) title = heading.text;
    }
    const t = /^\s*[-*]\s+\[([ xX])\]\s+(.+?)\s*$/.exec(line);
    if (t) tasks.push({ done: t[1].toLowerCase() === "x", text: t[2].trim(), line: index + 1 });
  });
  // A heading "has content" when at least one non-blank line sits between it and the next
  // heading (or EOF) — used to distinguish a real section from a bare, empty heading (e.g. an
  // empty "## Verification" that satisfies has("verification") by name alone).
  headings.forEach((heading, index) => {
    const sectionEnd = headings[index + 1]?.line ?? lines.length + 1;
    heading.hasContent = lines.slice(heading.line, sectionEnd - 1).some((line) => line.trim().length > 0);
  });
  return {
    context,
    frontmatter,
    findings,
    warnings,
    title,
    headings,
    tasks,
    notTested: notTestedEntries(headings, tasks, lines.length),
    taskCounts: {
      total: tasks.length,
      complete: tasks.filter((task) => task.done).length,
      remaining: tasks.filter((task) => !task.done).length,
    },
  };
}

// The checkboxes under a `## Not tested` heading: built work no test covers. The section runs to the
// next heading at the same or a shallower depth, so sub-headings inside it stay part of it. Only a
// literal top-level `## Not tested` counts: prose headings that merely discuss the section, such as
// ``### `## Not tested` ``, must not turn their examples into entries.
function notTestedEntries(headings, tasks, lineCount) {
  const index = headings.findIndex((heading) => heading.depth === 2 && heading.text.toLowerCase() === "not tested");
  if (index === -1) return { present: false, entries: [], unchecked: 0 };
  const start = headings[index];
  const next = headings.slice(index + 1).find((heading) => heading.depth <= start.depth);
  const end = next ? next.line : lineCount + 1;
  const entries = tasks.filter((task) => task.line > start.line && task.line < end);
  return { present: true, entries, unchecked: entries.filter((task) => !task.done).length };
}

export function parseFrontmatter(markdown) {
  const bail = (code) => {
    const findings = [finding(code)];
    return { frontmatter: {}, body: markdown, findings, warnings: messagesOf(findings) };
  };
  if (!markdown.startsWith("---\n")) return bail("MISSING_FRONTMATTER");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return bail("UNCLOSED_FRONTMATTER");
  const raw = markdown.slice(4, end).split("\n");
  const body = markdown.slice(end + 4).replace(/^\n/, "");
  const frontmatter = {};
  const findings = [];
  let current = null;
  raw.forEach((line, index) => {
    if (!line.trim()) return;
    const list = /^\s+-\s+(.+?)\s*$/.exec(line);
    if (list && current) {
      // Unquote the same way scalar values are. An entry gets quoted precisely when it contains a
      // colon — an external blocker reads as prose — and leaving the quotes attached would make the
      // value fail every downstream check that inspects its prefix.
      frontmatter[current].push(list[1].replace(/^["']|["']$/g, ""));
      return;
    }
    const match = /^([a-zA-Z_][a-zA-Z0-9_-]*):(?:\s*(.*))?$/.exec(line);
    if (!match) {
      findings.push(finding("UNSUPPORTED_FRONTMATTER_SYNTAX", { meta: { line: index + 1 } }));
      current = null;
      return;
    }
    const [, key, value = ""] = match;
    if (Object.prototype.hasOwnProperty.call(frontmatter, key)) {
      findings.push(finding("DUPLICATE_FRONTMATTER_KEY", { meta: { key } }));
    }
    if (value === "[]") {
      frontmatter[key] = [];
      current = null;
    } else if (value === "") {
      frontmatter[key] = arrayField(key) ? [] : "";
      current = arrayField(key) ? key : null;
    } else if (/^\[.*\]$/.test(value)) {
      frontmatter[key] = parseInlineArray(value);
      current = null;
    } else {
      frontmatter[key] = value.replace(/^["']|["']$/g, "");
      current = null;
    }
  });
  return {
    frontmatter: normalizeFrontmatter(frontmatter, findings),
    body,
    findings,
    warnings: messagesOf(findings),
  };
}

// Narrow scalar-only frontmatter writer: patches one `key: value` line in place, preserving key
// order, blank lines, and the entire body byte-for-byte. Appends the key (at the end of the
// frontmatter block) when it's missing entirely — a plan with no `priority:` line at all renders
// the same "none" fallback in buildPlanRecord() as one with an empty value, so the writer must be
// able to turn either into a real on-disk line. Does not support list fields (blocked_by etc).
export // YAML flow sequences (`related: [a, b]`). Both list forms are valid YAML and authors write both,
// so the parser accepts both rather than reporting one as unsupported. Splitting respects quotes,
// because a quoted entry may legitimately contain a comma — an external blocker reads as prose, not
// as an id.
function parseInlineArray(value) {
  const inner = value.slice(1, -1);
  const entries = [];
  let buffer = "";
  let quote = null;
  for (const char of inner) {
    if (quote) {
      if (char === quote) quote = null;
      else buffer += char;
      continue;
    }
    if (char === '"' || char === "'") {
      quote = char;
      continue;
    }
    if (char === ",") {
      entries.push(buffer);
      buffer = "";
      continue;
    }
    buffer += char;
  }
  entries.push(buffer);
  return entries.map((entry) => entry.trim()).filter(Boolean);
}

export function writeFrontmatterField(markdown, key, value) {
  if (!markdown.startsWith("---\n")) throw new Error("missing frontmatter");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) throw new Error("unclosed frontmatter");
  const rawLines = markdown.slice(4, end).split("\n");
  const bodyAndClose = markdown.slice(end);
  const pattern = new RegExp(`^${key}:.*$`);
  let found = false;
  const updated = rawLines.map((line) => {
    if (pattern.test(line)) {
      found = true;
      return `${key}: ${value}`;
    }
    return line;
  });
  if (!found) updated.push(`${key}: ${value}`);
  return `---\n${updated.join("\n")}${bodyAndClose}`;
}

// Pure path builder for a lifecycle move destination. Filename is preserved unchanged — lifecycle
// moves never rename the file.
function resolveDestinationPath(repositoryRoot, lifecycle, filename) {
  return path.join(repositoryRoot, "docs", "plans", lifecycle, filename);
}

// Where a lifecycle move puts a plan, refusing a destination outside the repository or one already
// occupied. The portal's movePlanLifecycle and `roborepo plans start` both move plans through this,
// so the two paths into `active/` cannot disagree about where a plan lands.
export function lifecycleMoveDestination(realRepo, realFile, lifecycle) {
  if (!inside(realRepo, realFile)) throw domainError("MOVE_FAILED", "plan file escaped repository boundary");
  const filename = path.basename(realFile);
  const destination = resolveDestinationPath(realRepo, lifecycle, filename);
  if (!inside(realRepo, destination)) throw domainError("MOVE_FAILED", "destination escaped repository boundary");
  let occupied = true;
  try {
    fs.lstatSync(destination);
  } catch (err) {
    if (err?.code !== "ENOENT") throw err;
    occupied = false;
  }
  if (occupied) throw domainError("DESTINATION_EXISTS", "A file already exists at the destination.");
  return { filename, destination };
}

// Resolves the real (symlink-followed) path of a plan file expected to still be at
// `absolutePath`. Translates a missing file into STALE_PLAN rather than leaking a raw ENOENT —
// the file may have moved externally (the stable id could still resolve elsewhere on a rescan)
// or been deleted; either way it's a stale-state conflict, not a generic filesystem error.
function realpathOrStale(absolutePath) {
  try {
    return fs.realpathSync(absolutePath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      throw domainError("STALE_PLAN", "This plan changed outside the portal, so the update wasn't applied.", {
        resolution: "The page will refresh to show the current state.",
        details: ["the file is no longer at its last known location"],
      });
    }
    throw err;
  }
}

// Rebuilds and caches a full public plan record for a file already on disk at `absolutePath`,
// reusing the same buildPlanRecord/readPlanRecord path the snapshot scanner uses, so mutation
// results have the identical shape (and warnings/readiness/etc are freshly derived) as a record
// that came from a normal scan.
function rebuildPlanRecordAt(repository, absolutePath) {
  const relativePath = relative(repository.root, absolutePath);
  const stat = fs.statSync(absolutePath);
  const namespaces = readProjectNamespaces(repository.root).namespaces;
  const record = buildPlanRecord(repository, absolutePath, relativePath, stat, namespaces);
  planRecordCache.set(absolutePath, {
    mtimeMs: stat.mtimeMs,
    repositoryRoot: repository.root,
    namespaceKey: namespaces.join(","),
    record,
  });
  return publicPlan(record);
}

// Per-field validators for the generic scalar frontmatter mutation below. Only fields meant to be
// human-edited via the portal belong here — see plan-schema.md's field-by-field rules for which
// frontmatter keys are UI-editable vs. author/automated-tooling-only (id and reviewed_commit are
// never UI-edited; blocked_by/depends_on/related are arrays writeFrontmatterField can't touch).
const FIELD_VALIDATORS = {
  priority: (value) => PRIORITIES.has(value),
};

// Generic scalar frontmatter field mutation: validate the new value, confirm the record hasn't
// gone stale, patch the one frontmatter line, and return the same { change, record } shape every
// mutation in this module returns. Only fields listed in FIELD_VALIDATORS are accepted.
export function updatePlanField(snapshot, { id, key, property, value, expectedValue, mtimeMs, repositoryId }) {
  const validate = FIELD_VALIDATORS[property];
  if (!validate) throw domainError("INVALID_CHANGE", `field not editable: ${property}`);
  if (!validate(value)) throw domainError("INVALID_CHANGE", `invalid ${property}`);
  const record = resolvePlanForMutation(snapshot, { id, key, repositoryId });
  assertExpectedState(record, { key, expectedField: property, expectedValue, mtimeMs });
  if (!record.absolutePath) throw domainError("PLAN_NOT_FOUND", "plan file path unavailable");
  const repoRoot = record.repository.root;
  const realRepo = fs.realpathSync(repoRoot);
  const realFile = realpathOrStale(record.absolutePath);
  if (!inside(realRepo, realFile)) throw domainError("MOVE_FAILED", "plan file escaped repository boundary");
  const markdown = fs.readFileSync(realFile, "utf8");
  const updated = writeFrontmatterField(markdown, property, value);
  fs.writeFileSync(realFile, updated);
  planRecordCache.delete(record.absolutePath);
  const rebuilt = rebuildPlanRecordAt(record.repository, realFile);
  return {
    change: { property, previousValue: record.plan[property], newValue: value },
    record: rebuilt,
  };
}

export function updatePlanPriority(snapshot, { id, key, priority, expectedPriority, mtimeMs, repositoryId }) {
  return updatePlanField(snapshot, { id, key, property: "priority", value: priority, expectedValue: expectedPriority, mtimeMs, repositoryId });
}

// Implements the doc's 11-step lifecycle-move validation order: enum check, stable-identity
// resolution, stale-state check, repository-boundary confirmation, destination construction,
// collision check, destination-requirement validation, then the atomic rename.
export function movePlanLifecycle(snapshot, { id, key, lifecycle, expectedLifecycle, mtimeMs, repositoryId, skipDestinationValidation = false }) {
  if (!LIFECYCLES.has(lifecycle)) throw domainError("INVALID_CHANGE", `invalid lifecycle: ${lifecycle}`);
  const record = resolvePlanForMutation(snapshot, { id, key, repositoryId });
  if (record.plan.lifecycle === lifecycle) throw domainError("INVALID_CHANGE", `plan is already ${lifecycle}`);
  assertExpectedState(record, { key, expectedLifecycle, mtimeMs });
  if (!record.absolutePath) throw domainError("PLAN_NOT_FOUND", "plan file path unavailable");

  const repoRoot = record.repository.root;
  const realRepo = fs.realpathSync(repoRoot);
  const realFile = realpathOrStale(record.absolutePath);
  if (!inside(realRepo, realFile)) throw domainError("MOVE_FAILED", "plan file escaped repository boundary");

  const { filename, destination } = lifecycleMoveDestination(realRepo, realFile, lifecycle);

  // Non-blocking by design: the first call always validates and, if incomplete, throws
  // LIFECYCLE_REQUIREMENTS so the client can show what's missing. The client re-submits with
  // skipDestinationValidation once the user confirms "move anyway" — this is a soft warning, not
  // a hard gate, because most existing plan docs predate the plan-suite schema and can't cleanly
  // satisfy every section/next_action/verification check without a dedicated backfill pass.
  //
  // Validation reads the file from disk rather than trusting the snapshot record, so the findings
  // (and the repair prompt generated from them) always describe the document as it is right now.
  // An edit made since the page loaded is picked up here.
  if (!skipDestinationValidation) {
    const markdown = fs.readFileSync(realFile, "utf8");
    const publicRepository = stripRepositoryRoot(record.repository);
    const parsed = parsePlanMarkdown(markdown, { repository: publicRepository, relativePath: record.plan.relativePath });
    // The filename travels with the file, so naming is evaluated against the destination
    // lifecycle: a name that is only reported in backlog and active stops being reported the
    // moment the same file lands in completed or archived.
    const destinationValidation = validateParsedPlan(parsed, {
      lifecycle,
      // The same `filename` the destination path was built from, taken from disk rather than the
      // snapshot record, so validation cannot grade a name different from the one the move creates.
      filename,
      projectNamespaces: readProjectNamespaces(record.repository.root).namespaces,
    });
    if (!destinationValidation.ready) {
      throw domainError("LIFECYCLE_REQUIREMENTS", `Couldn't move "${record.plan.title}" to ${capitalize(lifecycle)}.`, {
        resolution: "Complete or remove the listed items, then try again — or move anyway.",
        details: destinationValidation.warnings,
        findings: destinationValidation.findings,
        // Generated here, from this same fresh validation, rather than exposing a second endpoint
        // the client could call with its own findings — the prompt can then never describe
        // requirements different from the ones currently on screen.
        repair: {
          prompt: buildRepairPrompt({
            repository: publicRepository,
            plan: record.plan,
            sourceLifecycle: record.plan.lifecycle,
            destinationLifecycle: lifecycle,
            findings: destinationValidation.findings,
          }),
          planKey: record.key,
          planId: record.plan.id,
        },
      });
    }
  }

  fs.mkdirSync(path.dirname(destination), { recursive: true });
  try {
    fs.renameSync(realFile, destination);
  } catch {
    throw domainError("MOVE_FAILED", "Couldn't move the plan file. Nothing was changed.");
  }

  planRecordCache.delete(realFile);
  const rebuilt = rebuildPlanRecordAt(record.repository, destination);
  return {
    change: { property: "lifecycle", previousValue: record.plan.lifecycle, newValue: lifecycle },
    record: rebuilt,
  };
}

function capitalize(text) {
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function normalizeFrontmatter(frontmatter, findings) {
  for (const key of ["blocked_by", "depends_on", "related"]) {
    if (frontmatter[key] === undefined) frontmatter[key] = [];
    if (!Array.isArray(frontmatter[key])) {
      findings.push(finding("NON_ARRAY_FIELD", { meta: { key } }));
      frontmatter[key] = [];
    }
  }
  if (frontmatter.priority && !PRIORITIES.has(frontmatter.priority)) {
    findings.push(finding("INVALID_PRIORITY_VALUE", { meta: { value: frontmatter.priority } }));
  }
  if (frontmatter.id) {
    const idFormat = classifyPlanId(frontmatter.id);
    if (idFormat === "invalid") {
      findings.push(finding("INVALID_ID", { meta: { value: frontmatter.id } }));
    } else if (idFormat === "legacy") {
      // LEGACY(slug-ids): informational only — existing slug ids are valid and must not be
      // rewritten, since ids are the durable identity inbound references resolve against. Reports
      // which convention a plan uses; it is not a backlog item.
      findings.push(finding("LEGACY_SLUG_ID", { meta: { value: frontmatter.id } }));
    }
  }
  return frontmatter;
}

// Thin adapter over the destination-policy module — the rules themselves live in
// lifecycle-policy.mjs, which is pure and filesystem-free so the same evaluation runs from the
// scanner, from movePlanLifecycle, and from tests.
//
// Naming is validated alongside it rather than inside it: lifecycle-policy reads a parsed document
// and knows nothing about where that document sits on disk, while naming needs the filename and the
// repository's declared namespaces. Both produce the same finding shape, so the two lists merge and
// every downstream consumer (portal, API, repair prompt) sees one result.
function validateParsedPlan(parsed, { lifecycle, filename = "", projectNamespaces = [] }) {
  const { findings } = validateForLifecycle(parsed, { lifecycle, priorities: PRIORITIES, normalizeHeading });
  const all = [...findings, ...validatePlanNaming({ filename, lifecycle, projectNamespaces })];
  return { ready: all.length === 0, findings: all, warnings: messagesOf(all) };
}

// Cross-plan problems, which can only be evaluated once every plan in the snapshot is known —
// hence a separate pass from the per-document validators. Returns findings keyed by plan key.
function relationshipFindings(plans) {
  const byRepoAndId = new Map();
  for (const record of plans) {
    if (!record.plan.id) continue;
    const key = `${record.repository.id}:${record.plan.id}`;
    if (!byRepoAndId.has(key)) byRepoAndId.set(key, []);
    byRepoAndId.get(key).push(record);
  }
  const findings = new Map();
  for (const matches of byRepoAndId.values()) {
    if (matches.length < 2) continue;
    for (const record of matches) {
      addFinding(findings, record.key, finding("DUPLICATE_PLAN_ID", { meta: { id: record.plan.id } }));
    }
  }
  // Every id-bearing field is resolved the same way. Referential integrity is what actually catches
  // a wrong id — a format check only catches a malformed one, so a transposed character in an
  // otherwise well-formed id falls straight through it.
  const RELATIONS = [
    ["dependencies", "DEPENDENCY_NOT_FOUND", "dependency"],
    ["related", "RELATED_NOT_FOUND", "related"],
    ["blockers", "BLOCKER_NOT_FOUND", "blocker"],
  ];
  for (const record of plans) {
    for (const dep of record.plan.dependencies || []) {
      if (dep === record.plan.id) addFinding(findings, record.key, finding("SELF_DEPENDENCY"));
    }
    for (const [field, code, metaKey] of RELATIONS) {
      for (const ref of record.plan[field] || []) {
        if (!ref) continue;
        // An external blocker names something with no plan document, so there is nothing to resolve
        // against. Only `blocked_by` may carry one; depends_on/related are plan-to-plan by design.
        if (field === "blockers" && isExternalBlocker(ref)) continue;
        if (!byRepoAndId.has(`${record.repository.id}:${ref}`)) {
          addFinding(findings, record.key, finding(code, { meta: { [metaKey]: ref } }));
        }
      }
    }
  }
  return findings;
}

function gitInfo(root) {
  const head = git(root, ["rev-parse", "--verify", "HEAD"]);
  const branch = git(root, ["branch", "--show-current"]);
  return { available: head.ok, head: head.ok ? head.stdout : null, branch: branch.ok ? branch.stdout : null };
}

function gitFileInfo(root, relativePath, reviewedCommit) {
  const last = git(root, ["log", "-1", "--format=%cI", "--", relativePath]);
  const status = git(root, ["status", "--porcelain", "--", relativePath]);
  let reviewState = "never-reviewed";
  if (reviewedCommit) {
    const head = git(root, ["rev-parse", "--verify", "HEAD"]);
    const ancestor = head.ok ? git(root, ["merge-base", "--is-ancestor", reviewedCommit, "HEAD"]) : { ok: false };
    if (!head.ok || !ancestor.ok) reviewState = "unknown";
    else reviewState = reviewedCommit === head.stdout ? "current" : "possibly-stale";
  }
  return {
    lastChangedAt: last.ok ? last.stdout : null,
    status: status.ok && status.stdout ? status.stdout : null,
    reviewState,
  };
}

function git(cwd, args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim() };
}

export function publicPlan(record) {
  return {
    key: record.key,
    absolutePath: record.absolutePath,
    mtimeMs: record.mtimeMs,
    repository: publicRepository(record.repository),
    plan: record.plan,
  };
}

function stripPrivatePath(record) {
  const { absolutePath, repository, ...rest } = record;
  return { ...rest, repository: stripRepositoryRoot(repository) };
}

function stripRepositoryRoot(repository) {
  const { root, ...publicRepo } = repository || {};
  return publicRepo;
}

export function publicRepository(repo) {
  return {
    id: repo.id,
    repositoryId: repo.repositoryId ?? null,
    name: repo.name,
    root: repo.root,
    providerUrl: repo.providerUrl ?? null,
    gitHead: repo.gitHead,
    branch: repo.branch,
    gitAvailable: repo.gitAvailable,
  };
}

function portablePlanSummary(item) {
  return [
    `Repository: ${item.repository.name}`,
    `Path: ${item.plan.relativePath}`,
    `ID: ${item.plan.id || "(missing)"}`,
    `Lifecycle: ${item.plan.lifecycle}`,
    `Priority: ${item.plan.priority}`,
    `Next action: ${item.plan.nextAction || "(none)"}`,
    `Warnings: ${item.plan.validation.warnings.slice(0, 5).join("; ") || "none"}`,
    `Excerpt: ${item.plan.excerpt || "(none)"}`,
    "",
  ].join("\n");
}

function lifecycleFromPath(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts[0] !== "docs" || parts[1] !== "plans") return "unknown";
  const lifecycle = parts[2];
  return LIFECYCLES.has(lifecycle) ? lifecycle : "unclassified";
}

function normalizeHeading(text) {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

function excerpt(markdown) {
  return markdown
    .replace(/^---[\s\S]*?\n---\n?/, "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"))
    .join(" ")
    .slice(0, 500);
}

function emptyParsed(code) {
  const findings = [finding(code)];
  return {
    frontmatter: {},
    findings,
    warnings: messagesOf(findings),
    title: "",
    headings: [],
    tasks: [],
    taskCounts: { total: 0, complete: 0, remaining: 0 },
    notTested: { present: false, entries: [], unchecked: 0 },
  };
}

function arrayField(key) {
  return ["blocked_by", "depends_on", "related"].includes(key);
}

function addFinding(map, key, item) {
  if (!map.has(key)) map.set(key, []);
  map.get(key).push(item);
}

function relative(root, target) {
  return path.relative(root, target).split(path.sep).join("/");
}

function inside(root, target) {
  const rel = path.relative(root, target);
  return rel === "" || (!rel.startsWith("..") && !path.isAbsolute(rel));
}

function stableKey(input) {
  return crypto.createHash("sha256").update(input).digest("hex").slice(0, 16);
}