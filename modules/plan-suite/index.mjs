import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { resolveGitDir, resolveProjectIdentity, canonicalRepositoryId, providerUrlForRepositoryId } from "../repositories/index.mjs";
import { linkedWorktrees } from "../repositories/worktree-inventory.mjs";
import { finding, messagesOf } from "./findings.mjs";
import { validateForLifecycle } from "./lifecycle-policy.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { reviewRecord } from "./review-record.mjs";
import { classifyPlanId, isExternalBlocker } from "./plan-id.mjs";
import { validatePlanNaming, readProjectNamespaces, resolvePlanNamespace } from "./naming.mjs";
import { findDependencyCycles } from "./backlog-order.mjs";
import { renderMarkdown } from "../../scripts/cli/markdown-render.mjs";
import { PLANS_DIR, requireStore } from "./plan-store.mjs";

// The lifecycle folders a plan can live in, from manifests/platform/plan-lifecycle.json.
export const LIFECYCLES = LIFECYCLE_MODEL.folders;
const MAX_DOC_BYTES = 1024 * 1024;
const MAX_PLANS_PER_REPO = 500;

// Per-file record cache keyed by absolute path. Each entry is invalidated the moment a file's own
// mtime changes, so edits are always picked up — this only skips the expensive re-parse + git
// shell-outs (readPlanRecord) for files that haven't changed since the last scan. Directory
// listing still runs on every call (cheap `readdirSync`), so new/removed files are always seen.
const planRecordCache = new Map();

// Plans scans the repositories RoboRepo knows about; the scan lives beside this module.
export { buildPlanSnapshot } from "./canonical-scan.mjs";
export { planSnapshotFingerprint } from "./snapshot-fingerprint.mjs";

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
// Any checkout of the repository resolves to the same store, so this reads alike from all of them.
export function buildRepositoryPlanSnapshot({ cwd = process.cwd() } = {}) {
  const store = requireStore(path.resolve(cwd));
  const repository = { ...repositoryRecord(fs.realpathSync(store.root), { name: path.basename(store.primary) }), codeRoot: store.primary };
  const plans = withRelationshipFindings(discoverPlansInRepository(repository));
  return { repository: publicRepository(repository), root: repository.root, plans };
}

// Resolves `selector` — a plan id, or a store-relative path such as plans/ready/x.md, a path relative
// to the current directory, or an absolute one — to one record of a repository snapshot.
export function selectRepositoryPlan(snapshot, selector, { cwd = process.cwd() } = {}) {
  const byId = snapshot.plans.filter((record) => record.plan.id && record.plan.id === selector);
  if (byId.length === 1) return byId[0];
  const candidates = [path.resolve(snapshot.root, selector), path.resolve(cwd, selector)];
  const byPath = snapshot.plans.find((record) => candidates.some((candidate) => samePath(candidate, record.absolutePath)));
  if (byPath) return byPath;
  if (byId.length > 1) {
    throw domainError("INVALID_CHANGE", `More than one plan has id ${selector}.`, {
      resolution: "Pass the plan's store-relative path instead, such as plans/ready/x.md.",
      details: byId.map((record) => record.plan.relativePath),
    });
  }
  throw domainError("PLAN_NOT_FOUND", `No plan matches ${selector}.`, {
    resolution: "Pass a plan id or a plans/... path in this repo.",
  });
}

// `roborepo plans validate`.
export { validateRepositoryPlans } from "./repository-validation.mjs";

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
  STALE_ORDER: 409,
  DESTINATION_EXISTS: 409,
  LIFECYCLE_REQUIREMENTS: 422,
  PLAN_NOT_FOUND: 404,
  MOVE_FAILED: 500,
  PLAN_STORE_NOT_SET_UP: 409,
  PLAN_STORE_INIT_FAILED: 500,
  PLAN_STORE_CONFLICT: 409,
  PLAN_STORE_DIVERGED: 409,
  PLAN_STORE_DIRTY: 409,
  PLAN_STORE_BUSY: 409,
  PLAN_STORE_FAILED: 500,
};

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
    // Only for this one plan the reader opened, for its copy-path button. Snapshots leave it out.
    absolutePath: publicRecord.absolutePath,
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

// The suite commands a portal prompt may open with: every copy-prompt action the lifecycle manifest
// offers. Each takes no mode argument; anything else (including no command at all) yields a
// context-only prompt with no slash line.
export const PLAN_SUITE_COMMANDS = new Set(LIFECYCLE_MODEL.states.flatMap((state) => state.actions.map((action) => action.command)));

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
  ].join("\n");
}

// `root` is the plans worktree. `canonical` carries the registry's identity when the scan comes from
// a known repository, and at least its display name otherwise.
export function repositoryRecord(root, canonical = null) {
  const git = gitInfo(root);
  const repositoryId = canonical?.repositoryId ?? canonicalRepositoryId(resolveProjectIdentity(root, "plan-suite"));
  return {
    id: stableKey(canonical?.repositoryId ?? root),
    repositoryId,
    name: canonical?.name ?? path.basename(root),
    // The `?repo=` key, so a plan's repo badge can apply the Portal repo filter.
    urlKey: canonical?.urlKey ?? null,
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
  const plansDir = path.join(repository.root, PLANS_DIR);
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
  const stage = lifecycleFromPath(relativePath);
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
    && cached.record.plan.lifecycle === stage
  ) {
    // Repository-level fields (truncated/errors) can change between scans even when the file
    // itself hasn't, so refresh those on the cached record instead of trusting them blindly.
    return { ...cached.record, repository };
  }
  const record = buildPlanRecord(repository, absolutePath, relativePath, stat, namespaces, stage);
  planRecordCache.set(absolutePath, { mtimeMs: stat.mtimeMs, repositoryRoot: repository.root, namespaceKey, record });
  return record;
}

function buildPlanRecord(repository, absolutePath, relativePath, stat, projectNamespaces = [], lifecycle = lifecycleFromPath(relativePath)) {
  const tooLarge = stat.size > MAX_DOC_BYTES;
  const markdown = tooLarge ? "" : fs.readFileSync(absolutePath, "utf8");
  const parsed = tooLarge ? emptyParsed("DOCUMENT_TOO_LARGE") : parsePlanMarkdown(markdown, { repository, relativePath });
  const git = gitFileInfo(repository, relativePath, parsed.frontmatter);
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
      // Derived from the filename and the repository's approved vocabulary, never stored; null sends
      // a Backlog plan to No namespace for repair.
      namespace: resolvePlanNamespace(path.basename(relativePath), projectNamespaces),
      nextAction: parsed.frontmatter.next_action || "",
      blockers: parsed.frontmatter.blocked_by || [],
      dependencies: parsed.frontmatter.depends_on || [],
      related: parsed.frontmatter.related || [],
      reviewedCommit: parsed.frontmatter.reviewed_commit || "",
      // Git's administrative name for the one linked worktree implementing this plan.
      // Empty means unassociated; Home joins it to Runtime's git.worktreeName.
      worktree: typeof parsed.frontmatter.worktree === "string" ? parsed.frontmatter.worktree.trim() : "",
      reviewState: git.reviewState,
      modifiedAt: stat.mtime.toISOString(),
      gitLastChangedAt: git.lastChangedAt,
      gitStatus: git.status,
      taskCounts: parsed.taskCounts,
      // Unchecked `## Not tested` entries, which are tasks too but never block implementation
      // completion; `taskCounts.remaining` minus this is the work still open.
      notTestedOpen: parsed.notTested.unchecked,
      // The outcome recorded in `## Review`, kept apart from task progress: open findings and the
      // recorded decision. Whether an approval is still fresh needs Git and is checked at close.
      qa: qaSummary(parsed.review),
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
    review: reviewRecord(headings, tasks, lines),
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

// YAML flow sequences (`related: [a, b]`). Both list forms are valid YAML and authors write both,
// so the parser accepts both rather than reporting one as unsupported. Splitting respects quotes,
// because a quoted entry may legitimately contain a comma — an external blocker reads as prose, not
// as an id.
export function parseInlineArray(value) {
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

// Narrow scalar-only frontmatter writer: patches one `key: value` line in place, preserving key
// order, blank lines, and the entire body byte-for-byte. Appends the key (at the end of the
// frontmatter block) when it's missing entirely. Does not support list fields (blocked_by etc).
export function writeFrontmatterField(markdown, key, value) {
  if (!markdown.startsWith("---\n")) throw new Error("missing frontmatter");
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) throw new Error("unclosed frontmatter");
  const rawLines = markdown.slice(4, end).split("\n");
  const bodyAndClose = markdown.slice(end);
  const pattern = new RegExp(`^${key}:.*$`);
  // An empty value is written as a bare `key:`, the form plan templates use for an unset field.
  const line = value === "" ? `${key}:` : `${key}: ${value}`;
  let found = false;
  const updated = rawLines.map((current) => {
    if (pattern.test(current)) {
      found = true;
      return line;
    }
    return current;
  });
  if (!found) updated.push(line);
  return `---\n${updated.join("\n")}${bodyAndClose}`;
}

// Drops one entry from a list field, keeping the field's form (flow or block), key order, and the body
// byte-for-byte. A list left empty becomes `key: []`. Returns the input unchanged when the entry is absent.
export function removeFrontmatterListEntry(markdown, key, entry) {
  if (!markdown.startsWith("---\n")) return markdown;
  const end = markdown.indexOf("\n---", 4);
  if (end === -1) return markdown;
  const lines = markdown.slice(4, end).split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${key}:`));
  if (index === -1) return markdown;
  const value = lines[index].slice(key.length + 1).trim();
  const updated = /^\[.*\]$/.test(value)
    ? withoutFlowEntry(lines, index, key, value, entry)
    : withoutBlockEntry(lines, index, key, entry);
  return updated ? `---\n${updated.join("\n")}${markdown.slice(end)}` : markdown;
}

function withoutFlowEntry(lines, index, key, value, entry) {
  const entries = parseInlineArray(value);
  const kept = entries.filter((item) => item !== entry);
  if (kept.length === entries.length) return null;
  // Quotes stay if the author used them; a comma always needs them.
  const quoted = value.includes('"') || value.includes("'");
  const items = kept.map((item) => (quoted || item.includes(",") ? JSON.stringify(item) : item));
  return lines.with(index, `${key}: [${items.join(", ")}]`);
}

function withoutBlockEntry(lines, index, key, entry) {
  let last = index;
  while (/^\s+-\s+/.test(lines[last + 1] ?? "")) last += 1;
  const items = lines.slice(index + 1, last + 1);
  const kept = items.filter((line) => line.replace(/^\s+-\s+/, "").trim().replace(/^["']|["']$/g, "") !== entry);
  if (kept.length === items.length) return null;
  const head = kept.length ? lines[index] : `${key}: []`;
  return [...lines.slice(0, index), head, ...kept, ...lines.slice(last + 1)];
}

// Pure path builder for a lifecycle move destination. Filename is preserved unchanged — lifecycle
// moves never rename the file.
function resolveDestinationPath(repositoryRoot, lifecycle, filename) {
  return path.join(repositoryRoot, PLANS_DIR, lifecycle, filename);
}

// Where a lifecycle move puts a plan, refusing a destination outside the repository or one already
// occupied. Every transition in transition.mjs moves plans through this.
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

function normalizeFrontmatter(frontmatter, findings) {
  for (const key of ["blocked_by", "depends_on", "related"]) {
    if (frontmatter[key] === undefined) frontmatter[key] = [];
    if (!Array.isArray(frontmatter[key])) {
      findings.push(finding("NON_ARRAY_FIELD", { meta: { key } }));
      frontmatter[key] = [];
    }
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
// scanner, from the lifecycle transitions, and from tests.
//
// Naming is validated alongside it rather than inside it: lifecycle-policy reads a parsed document
// and knows nothing about where that document sits on disk, while naming needs the filename and the
// repository's declared namespaces. Both produce the same finding shape, so the two lists merge and
// every downstream consumer (portal, API, repair prompt) sees one result.
function validateParsedPlan(parsed, { lifecycle, filename = "", projectNamespaces = [] }) {
  const { findings } = validateForLifecycle(parsed, { lifecycle, normalizeHeading });
  const all = [...findings, ...validatePlanNaming({ filename, lifecycle, projectNamespaces })];
  return { ready: all.length === 0, findings: all, warnings: messagesOf(all) };
}

// What `markdown` would be judged against in `lifecycle`: the destination policy plus any blocking
// frontmatter parse failure. Naming and cross-plan findings are left out, since neither depends on
// the stage a plan is moving to. Returns { parsed, findings }.
export function lifecycleFindings(markdown, { lifecycle }) {
  const parsed = parsePlanMarkdown(markdown);
  const parseFailures = parsed.findings.filter((item) => item.severity === "blocking");
  const { findings } = validateForLifecycle(parsed, { lifecycle, normalizeHeading });
  return { parsed, findings: [...parseFailures, ...findings] };
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
  // Plan ids repeat across repositories, so each repository's graph is checked on its own.
  for (const repositoryId of new Set(plans.map((record) => record.repository.id))) {
    const inRepository = plans.filter((record) => record.repository.id === repositoryId);
    for (const cycle of findDependencyCycles(inRepository.map((record) => record.plan))) {
      for (const record of inRepository.filter((item) => cycle.includes(item.plan.id))) {
        addFinding(findings, record.key, finding("DEPENDENCY_CYCLE", { meta: { cycle } }));
      }
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

function gitFileInfo(repository, relativePath, frontmatter) {
  const { root } = repository;
  const last = git(root, ["log", "-1", "--format=%cI", "--", relativePath]);
  const status = git(root, ["status", "--porcelain", "--", relativePath]);
  const reviewedCommit = frontmatter.reviewed_commit;
  let reviewState = "never-reviewed";
  if (reviewedCommit) {
    // A reviewed commit is a code commit, so it is judged against the plan's implementation branch
    // and never against the plans branch.
    const code = implementationCheckout(root, frontmatter.worktree);
    const head = git(code, ["rev-parse", "--verify", "HEAD"]);
    const ancestor = head.ok ? git(code, ["merge-base", "--is-ancestor", reviewedCommit, "HEAD"]) : { ok: false };
    if (!head.ok || !ancestor.ok) reviewState = "unknown";
    else reviewState = reviewedCommit === head.stdout ? "current" : "possibly-stale";
  }
  return {
    lastChangedAt: last.ok ? last.stdout : null,
    status: status.ok && status.stdout ? status.stdout : null,
    reviewState,
  };
}

function implementationCheckout(storeRoot, worktree) {
  const commonDir = resolveGitDir(storeRoot)?.commonDir;
  if (!commonDir) return storeRoot;
  const name = typeof worktree === "string" ? worktree.trim() : "";
  return linkedWorktrees(commonDir).find((item) => item.name === name && !item.prunable)?.path ?? path.dirname(commonDir);
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
    urlKey: repo.urlKey ?? null,
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
    `Next action: ${item.plan.nextAction || "(none)"}`,
    `Warnings: ${item.plan.validation.warnings.slice(0, 5).join("; ") || "none"}`,
    `Excerpt: ${item.plan.excerpt || "(none)"}`,
    "",
  ].join("\n");
}

export function lifecycleFromPath(relativePath) {
  const parts = relativePath.split(/[\\/]/);
  if (parts[0] !== PLANS_DIR) return "unknown";
  const lifecycle = parts[1];
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
    review: { present: false, findings: { open: 0, total: 0 }, result: null, approval: null },
  };
}

function qaSummary(review) {
  return {
    reviewed: review.present,
    openFindings: review.findings.open,
    findings: review.findings.total,
    decision: review.approval?.decision || "",
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
