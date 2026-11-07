// The named plan writes that are not lifecycle moves: `plans save` (also the portal's upload),
// `plans approve`, and `plans config namespaces`. Each validates, then commits through the store.
//
// `plans save` owns a plan's content and never its lifecycle. An existing plan keeps its path whatever
// the source file is called; `id`, `worktree`, and `### Approval` belong to the lifecycle commands and
// `plans approve`, so a change to any of them is refused.
import fs from "node:fs";
import path from "node:path";
import { buildRepositoryPlanSnapshot, domainError, lifecycleFindings, parsePlanMarkdown, selectRepositoryPlan, writeFrontmatterField } from "./index.mjs";
import { LIFECYCLE_MODEL } from "./lifecycle-manifest.mjs";
import { PLANS_CONFIG_RELATIVE_PATH, readProjectNamespaces, validatePlanNaming } from "./naming.mjs";
import { git, primaryCheckout } from "./plan-git.mjs";
import { generatePlanId } from "./plan-id.mjs";
import { PLANS_DIR, mutateStore, requireStore } from "./plan-store.mjs";

const NEW_PLAN_LIFECYCLE = "backlog";
const TOLERATED = new Set(["UNCONFIRMED_NOT_TESTED"]);
const FULL_SHA = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;

// What a save would do, without doing it. Throws the refusal a save would throw. `root` is the store.
// A new plan's id is generated once by the caller so a preview and its retries name the same plan.
export function planSaveChange({ root, markdown, filename, newId = generatePlanId() }) {
  const name = path.basename(String(filename || ""));
  if (!name.endsWith(".md")) throw domainError("INVALID_CHANGE", "A plan must be a Markdown file ending in .md.");
  const parsed = parsePlanMarkdown(markdown);
  const parseFailures = parsed.findings.filter((item) => item.severity === "blocking");
  if (parseFailures.length) refuseFindings("This file is not a valid plan, so it was not saved.", parseFailures);

  const { plans } = buildRepositoryPlanSnapshot({ cwd: root });
  const id = String(parsed.frontmatter.id || "");
  const existing = id ? plans.find((record) => record.plan.id === id) : null;
  const sameName = plans.find((record) => path.basename(record.plan.relativePath) === name);
  if (existing) return existingPlanChange({ root, existing, markdown, id, parsed });
  if (sameName) {
    throw domainError("INVALID_CHANGE", `${name} is already the filename of another plan${sameName.plan.id ? ` (${sameName.plan.id})` : ""}, so this file was not saved.`, {
      resolution: id ? "Keep the plan's original id, or rename this file if it is a new plan." : "Add the plan's id to the file's frontmatter, or rename this file if it is a new plan.",
      details: [sameName.plan.relativePath],
    });
  }
  return newPlanChange({ root, markdown, name, id, newId, parsed });
}

function existingPlanChange({ root, existing, markdown, id, parsed }) {
  const current = fs.readFileSync(existing.absolutePath, "utf8");
  if (String(parsed.frontmatter.worktree || "").trim() !== existing.plan.worktree) {
    throw domainError("INVALID_CHANGE", "Saving can't change a plan's `worktree`, so this file was not saved.", {
      resolution: `Restore \`worktree: ${existing.plan.worktree}\`. \`roborepo plans start\` records a replacement worktree.`,
    });
  }
  if (approvalSection(markdown) !== approvalSection(current)) {
    throw domainError("INVALID_CHANGE", "Saving can't change a plan's `### Approval`, so this file was not saved.", {
      resolution: "Restore the section as it was. Only `roborepo plans approve` records approval.",
    });
  }
  assertValidFor(markdown, existing.plan.lifecycle);
  return {
    action: markdown === current ? "unchanged" : "update",
    id,
    title: parsed.title || path.basename(existing.plan.relativePath, ".md"),
    lifecycle: existing.plan.lifecycle,
    target: existing.plan.relativePath,
    before: current,
    after: markdown,
    root,
  };
}

function newPlanChange({ root, markdown, name, id, newId, parsed }) {
  if (String(parsed.frontmatter.worktree || "").trim()) {
    throw domainError("INVALID_CHANGE", "A new plan can't name a worktree, so this file was not saved.", {
      resolution: "Clear `worktree`. `roborepo plans start` records it when implementation begins.",
    });
  }
  if (approvalSection(markdown)) {
    throw domainError("INVALID_CHANGE", "A new plan can't carry a `### Approval`, so this file was not saved.", {
      resolution: "Remove the section. Only `roborepo plans approve` records approval.",
    });
  }
  const after = id ? markdown : writeFrontmatterField(markdown, "id", newId);
  assertValidFor(after, NEW_PLAN_LIFECYCLE);
  const { namespaces } = readProjectNamespaces(root);
  const naming = validatePlanNaming({ filename: name, lifecycle: NEW_PLAN_LIFECYCLE, projectNamespaces: namespaces });
  if (naming.length) refuseFindings("This plan's filename does not meet the repo's naming rules, so it was not saved.", naming);
  return {
    action: "create",
    id: id || newId,
    title: parsed.title || path.basename(name, ".md"),
    lifecycle: NEW_PLAN_LIFECYCLE,
    target: `${PLANS_DIR}/${NEW_PLAN_LIFECYCLE}/${name}`,
    before: "",
    after,
    root,
  };
}

function assertValidFor(markdown, lifecycle) {
  const blocking = lifecycleFindings(markdown, { lifecycle }).findings.filter((item) => item.severity === "blocking" && !TOLERATED.has(item.code));
  if (blocking.length) refuseFindings(`This file does not meet the ${lifecycle} requirements, so it was not saved.`, blocking);
}

function refuseFindings(message, findings) {
  throw domainError("LIFECYCLE_REQUIREMENTS", message, {
    resolution: "Resolve the listed findings, then save again.",
    details: findings.map((item) => `${item.code}: ${item.message}`),
    findings,
  });
}

export async function savePlan({ cwd = process.cwd(), store = requireStore(cwd), markdown, filename }) {
  const newId = generatePlanId();
  return mutateStore({
    store,
    operation: ({ root }) => {
      const change = planSaveChange({ root, markdown, filename, newId });
      const summary = { action: change.action, id: change.id, title: change.title, lifecycle: change.lifecycle, path: change.target };
      if (change.action === "unchanged") return { files: {}, result: summary };
      const verb = change.action === "create" ? "Add" : "Update";
      return { files: { [change.target]: change.after }, message: `${verb} plan ${path.basename(change.target, ".md")}`, result: summary };
    },
  });
}

// Records `### Approval` for one exact implementation commit. It records; whether the review earned it
// is /plan-review's judgment, and `plans approval` checks freshness afterward.
export async function approvePlan({ cwd = process.cwd(), store = requireStore(cwd), selector, commit, confirmedBy }) {
  const sha = String(commit || "").toLowerCase();
  if (!FULL_SHA.test(sha)) throw domainError("INVALID_CHANGE", "--commit must be a full commit id.");
  if (!String(confirmedBy || "").trim()) throw domainError("INVALID_CHANGE", "--confirmed-by must say who approved.");
  const primary = primaryCheckout(cwd);
  if (!git(primary, ["cat-file", "-e", `${sha}^{commit}`]).ok) {
    throw domainError("INVALID_CHANGE", `Commit ${sha} does not exist in this repo.`, { resolution: "Fetch it, or pass the reviewed implementation commit." });
  }
  return mutateStore({
    store,
    operation: ({ root }) => {
      const record = selectRepositoryPlan(buildRepositoryPlanSnapshot({ cwd: root }), selector, { cwd });
      if (!LIFECYCLE_MODEL.worktreeBound.has(record.plan.lifecycle)) {
        throw domainError("INVALID_CHANGE", `Only an active or review plan can be approved; this one is ${record.plan.lifecycle}.`, { details: [record.plan.relativePath] });
      }
      const updated = withApproval(fs.readFileSync(record.absolutePath, "utf8"), { commit: sha, confirmedBy: confirmedBy.trim() });
      return {
        files: { [record.plan.relativePath]: updated },
        message: `Record approval of plan ${path.basename(record.plan.relativePath, ".md")}`,
        result: { id: record.plan.id, path: record.plan.relativePath, commit: sha, confirmedBy: confirmedBy.trim() },
      };
    },
  });
}

// Replaces the `namespaces` table and nothing else in the config.
export async function setConfigNamespaces({ cwd = process.cwd(), store = requireStore(cwd), namespaces }) {
  const valid = namespaces && typeof namespaces === "object" && !Array.isArray(namespaces)
    && Object.entries(namespaces).every(([name, description]) => /^[a-z0-9]+(-[a-z0-9]+)*$/.test(name) && typeof description === "string" && description.trim());
  if (!valid) throw domainError("INVALID_CHANGE", "Namespaces must be a JSON object of lowercase hyphenated names to non-empty descriptions.");
  return mutateStore({
    store,
    operation: ({ root }) => {
      const file = path.join(root, PLANS_CONFIG_RELATIVE_PATH);
      const config = JSON.parse(fs.readFileSync(file, "utf8"));
      const text = `${JSON.stringify({ ...config, namespaces }, null, 2)}\n`;
      if (text === fs.readFileSync(file, "utf8")) return { files: {}, result: { namespaces: Object.keys(namespaces) } };
      return { files: { [PLANS_CONFIG_RELATIVE_PATH]: text }, message: "Update plan namespaces", result: { namespaces: Object.keys(namespaces) } };
    },
  });
}

// The raw lines of `### Approval` under `## Review`, or "" when absent. Fenced examples are not sections.
function approvalSection(markdown) {
  const { lines, start, end } = approvalBounds(markdown);
  return start < 0 ? "" : lines.slice(start, end).join("\n").trimEnd();
}

function approvalBounds(markdown) {
  const lines = String(markdown).split("\n");
  let fence = null;
  let inReview = false;
  let reviewEnd = -1;
  let reviewStart = -1;
  let start = -1;
  let end = -1;
  lines.forEach((line, index) => {
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line)?.[1];
    if (marker && !fence) { fence = marker; return; }
    if (fence) {
      if (marker?.[0] === fence[0] && marker.length >= fence.length) fence = null;
      return;
    }
    const heading = /^(#{1,6})\s+(.+?)\s*$/.exec(line);
    if (!heading) return;
    const depth = heading[1].length;
    if (start >= 0 && end < 0 && depth <= 3) end = index;
    if (inReview && depth <= 2) { inReview = false; reviewEnd = index; }
    if (depth === 2 && heading[2].toLowerCase() === "review") { inReview = true; reviewStart = index; }
    if (inReview && depth === 3 && heading[2].toLowerCase() === "approval" && start < 0) start = index;
  });
  if (start >= 0 && end < 0) end = lines.length;
  if (inReview) reviewEnd = lines.length;
  return { lines, start, end, reviewStart, reviewEnd };
}

function withApproval(markdown, { commit, confirmedBy }) {
  const block = ["### Approval", "- Decision: approved", `- Reviewed implementation commit: ${commit}`, `- Confirmed by: ${confirmedBy}`, ""];
  const { lines, start, end, reviewStart, reviewEnd } = approvalBounds(markdown);
  if (start >= 0) return [...lines.slice(0, start), ...block, ...lines.slice(end)].join("\n");
  if (reviewStart >= 0) {
    let insert = reviewEnd;
    while (insert > reviewStart + 1 && !lines[insert - 1].trim()) insert -= 1;
    return [...lines.slice(0, insert), "", ...block, ...lines.slice(reviewEnd)].join("\n");
  }
  return `${markdown.replace(/\s*$/, "")}\n\n## Review\n\n${block.join("\n")}`;
}
