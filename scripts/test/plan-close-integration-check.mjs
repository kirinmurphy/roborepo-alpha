#!/usr/bin/env node
// /plan-close step 0 (the integration check) decides from Git commands written into the skill. This
// runs those exact commands, read from the shipped SKILL.md, against temporary repositories and
// checks that they give the verdicts the skill documents: a squash merge is integrated, a rerun after
// a refusal note still is, new worktree progress is not, and a plan the worktree never touched is.
//
// `roborepo plans close` and `roborepo plans archive` repeat that decision in code
// (copy-integration.mjs), so every fixture also asserts the module agrees with the documented
// commands, and that the archive carry it drives takes a consistent primary copy and refuses one
// with an outside edit. The commits those transitions make are covered by
// plan-lifecycle-transitions-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildRepositoryPlanSnapshot, selectRepositoryPlan } from "../../modules/plan-suite/index.mjs";
import { archiveCarry, worktreeCopyIntegration } from "../../modules/plan-suite/copy-integration.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = fs.readFileSync(path.join(repoRoot, "globals/packages/plan-close/skills/plan-close/SKILL.md"), "utf8");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-close-integration-")));
const PLAN = "docs/plans/review/p.md";
Object.assign(process.env, { GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "t@example.com" });

// Step 0's command block, one template per line, with its trailing comments dropped.
const step0 = skill.slice(skill.indexOf("### 0. "), skill.indexOf("### 1. "));
const integrationCommands = step0.match(/```text\n([\s\S]*?)```/)[1].trim().split("\n").map((line) => line.replace(/#.*$/, "").trim());
assert.deepEqual(integrationCommands.map((line) => line.split(/\s+/)[1]), ["merge-base", "hash-object", "rev-parse", "log"], "step 0 documents the four commands this check runs");
assert.match(step0, /fourth field is the blob/);
assert.match(step0.replace(/\s+/g, " "), /canonical close transition command repeats this check before it commits/, "step 0 says the close command re-verifies it");
const closeStep = skill.slice(skill.indexOf("### 8. Close"), skill.indexOf("### 9. Stop"));
assert.match(closeStep, /canonical close transition command/, "step 8 commits through the close transition, not hand-written Git");
assert.match(closeStep.replace(/\s+/g, " "), /If it refuses,.*do not proceed with server or worktree cleanup/,
  "step 8 stops cleanup after a refused close");

function git(cwd, ...args) {
  const result = spawnSync("git", args, { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

// Runs one documented command template in the primary checkout; a failed `rev-parse` is "no such
// blob", as when the plan did not exist at the fork.
function documented(template, values, primary) {
  let line = template;
  for (const [token, value] of Object.entries(values)) line = line.replaceAll(token, value);
  const [command, ...args] = line.split(/\s+/);
  assert.equal(command, "git");
  const result = spawnSync("git", args, { cwd: primary, encoding: "utf8" });
  if (result.status !== 0 && args[0] === "rev-parse") return "";
  assert.equal(result.status, 0, `${line}: ${result.stderr}`);
  return result.stdout.trim();
}

const byCommand = (name) => integrationCommands.find((line) => line.split(/\s+/)[1] === name);
const producedBlobs = (rawLog) => new Set(rawLog.split("\n").filter((line) => line.startsWith(":")).map((line) => line.split(/\s+/)[3]));

// Step 0: "integrated" when the base branch already has every plan version the worktree has.
function documentedIntegration({ primary, worktree, branch }) {
  if (fs.readFileSync(path.join(worktree, PLAN)).equals(fs.readFileSync(path.join(primary, PLAN)))) return "integrated";
  const values = { "<branch>": branch, "<worktree>": worktree, "<plan path>": PLAN };
  values["<fork>"] = documented(byCommand("merge-base"), values, primary);
  const blob = documented(byCommand("hash-object"), values, primary);
  const atFork = documented(byCommand("rev-parse"), values, primary);
  const produced = producedBlobs(documented(byCommand("log"), values, primary));
  return blob === atFork || produced.has(blob) ? "integrated" : "not integrated";
}

const record = ({ primary }) => selectRepositoryPlan(buildRepositoryPlanSnapshot({ cwd: primary }), "p1", { cwd: primary });

// Asserts the documented commands and the module reach the same verdict, and returns it.
function integration(repo, label) {
  const verdict = documentedIntegration(repo);
  const state = worktreeCopyIntegration(repo.primary, record(repo)).state;
  assert.equal(state.replace("-", " "), verdict, `${label}: copy-integration.mjs agrees with the documented commands`);
  return verdict;
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A primary checkout whose plan `p.md`, in review, is assigned to worktree `wt`. Blank lines keep
// edits at the top and bottom of the plan mergeable.
function started(name) {
  const primary = path.join(tempRoot, name, "main");
  write(path.join(primary, PLAN), "---\nid: p1\npriority: low\nworktree: wt\n---\n\n# Plan\n\n- [ ] task\n\n\n\n\n## Notes\n");
  git(path.dirname(primary), "init", "-q", "-b", "main", primary);
  git(primary, "add", ".");
  git(primary, "commit", "-qm", "start p1");
  const worktree = path.join(tempRoot, name, "wt");
  git(primary, "worktree", "add", "-q", "-b", "wt", worktree);
  return { primary, worktree, branch: "wt" };
}

const edit = (checkout, from, to) => write(path.join(checkout, PLAN), fs.readFileSync(path.join(checkout, PLAN), "utf8").replace(from, to));

try {
  // ---- Completion: squash merge, rerun after a refusal, and new progress ----
  {
    const repo = started("squash");
    edit(repo.worktree, "- [ ] task", "- [x] task");
    write(path.join(repo.worktree, "feature.txt"), "feature\n");
    git(repo.worktree, "add", ".");
    git(repo.worktree, "commit", "-qm", "implement");
    assert.equal(integration(repo, "unmerged"), "not integrated", "unmerged plan progress has not landed");

    const fork = git(repo.primary, "merge-base", "HEAD", "wt");
    git(repo.primary, "merge", "-q", "--squash", "wt");
    git(repo.primary, "commit", "-qm", "squash-merge wt");
    assert.equal(git(repo.primary, "merge-base", "HEAD", "wt"), fork, "a squash merge leaves the fork where it was, so only the produced blobs can match");
    assert.equal(integration(repo, "squashed"), "integrated", "a squash-merged plan is integrated");

    // A later step refuses and records its notes in the primary copy, committed or not.
    edit(repo.primary, "## Notes\n", "## Notes\n\nRefused: a Not tested entry is unconfirmed.\n");
    assert.equal(integration(repo, "refusal note"), "integrated", "a refusal note in the primary copy does not block a rerun");
    git(repo.primary, "commit", "-qam", "plan-close notes");
    assert.equal(integration(repo, "committed note"), "integrated", "nor does a committed one");

    edit(repo.worktree, "# Plan", "# Plan, edited after the merge");
    assert.equal(integration(repo, "late edit"), "not integrated", "an uncommitted worktree edit after the merge has not landed");
    git(repo.worktree, "commit", "-qam", "edit after merge");
    assert.equal(integration(repo, "late commit"), "not integrated", "nor has a committed one");
  }

  // ---- A plan the worktree never edited is integrated, whatever happened on main ----
  {
    const repo = started("untouched");
    write(path.join(repo.worktree, "feature.txt"), "feature\n");
    git(repo.worktree, "add", ".");
    git(repo.worktree, "commit", "-qm", "implement");
    edit(repo.primary, "## Notes\n", "## Notes\n\nEdited on main.\n");
    git(repo.primary, "commit", "-qam", "edit on main");
    assert.equal(integration(repo, "untouched"), "integrated", "the worktree holds the plan at the fork, which main already had");
  }

  // ---- Archive carry for abandoned work ----
  {
    const repo = started("abandoned");
    edit(repo.worktree, "- [ ] task", "- [x] task\n\nStopped: superseded by another approach.");
    git(repo.worktree, "commit", "-qam", "partial work");
    assert.equal(integration(repo, "abandoned"), "not integrated");
    const carried = archiveCarry(repo.primary, record(repo));
    assert.equal(carried.worktreeCopy, "carried", "an untouched primary copy equals the plan at the fork");
    assert.match(carried.carry, /Stopped: superseded/, "the worktree's content is what gets carried");

    edit(repo.primary, "## Notes\n", "## Notes\n\nEdited on main.\n");
    assert.match(archiveCarry(repo.primary, record(repo)).refusal, /conflicting copies/, "an uncommitted outside edit on main refuses the carry");
    git(repo.primary, "commit", "-qam", "edit on main");
    assert.match(archiveCarry(repo.primary, record(repo)).refusal, /conflicting copies/, "so does a committed one");

    git(repo.worktree, "merge", "-q", "--no-edit", "main");
    assert.equal(archiveCarry(repo.primary, record(repo)).worktreeCopy, "carried", "merging main into the worktree resolves it");
  }

  console.log("plan-close integration commands: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
