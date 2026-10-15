#!/usr/bin/env node
// /plan-close step 0 (the integration check) and step 4's archive handoff decide from Git commands
// written into the skill. This runs those exact commands, read from the shipped SKILL.md, against
// temporary repositories and checks that they give the verdicts the skill documents: a squash
// merge is integrated, a rerun after a refusal note still is, new worktree progress is not, a plan
// the worktree never touched is, and archiving carries a consistent primary copy but refuses one
// with an outside edit. It also runs the documented plan-only close commit with unrelated work
// already staged, proving that the closure commit leaves that work in the index.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const skill = fs.readFileSync(path.join(repoRoot, "globals/packages/plan-close/skills/plan-close/SKILL.md"), "utf8");
const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-close-integration-")));
const PLAN = "docs/plans/active/p.md";

// Step 0's command block, one template per line, with its trailing comments dropped.
const step0 = skill.slice(skill.indexOf("### 0. "), skill.indexOf("### 1. "));
const integrationCommands = step0.match(/```text\n([\s\S]*?)```/)[1].trim().split("\n").map((line) => line.replace(/#.*$/, "").trim());
assert.deepEqual(integrationCommands.map((line) => line.split(/\s+/)[1]), ["merge-base", "hash-object", "rev-parse", "log"], "step 0 documents the four commands this check runs");
assert.match(step0, /fourth field is the blob/);
const archiveLog = skill.match(/`(git log --raw --no-abbrev --format= <fork>\.\.<branch> -- docs\/plans)`/)?.[1];
assert.ok(archiveLog, "step 4's archive table names the worktree branch's history command");
const closeStep = skill.slice(skill.indexOf("### 7. Close"), skill.indexOf("### 8. Stop"));
assert.match(closeStep, /git commit --only -m "Close plan <id>" -- <active plan path> <completed plan path>/,
  "step 7 documents a plan-only commit with both move paths");
assert.match(closeStep.replace(/\s+/g, " "), /If the commit fails,.*do not proceed with server or worktree cleanup/,
  "step 7 stops cleanup after a failed commit");

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.email=t@example.com", "-c", "user.name=Test", ...args], { cwd, encoding: "utf8" });
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
function integration({ primary, worktree, branch }) {
  if (fs.readFileSync(path.join(worktree, PLAN)).equals(fs.readFileSync(path.join(primary, PLAN)))) return "integrated";
  const values = { "<branch>": branch, "<worktree>": worktree, "<plan path>": PLAN };
  values["<fork>"] = documented(byCommand("merge-base"), values, primary);
  const blob = documented(byCommand("hash-object"), values, primary);
  const atFork = documented(byCommand("rev-parse"), values, primary);
  const produced = producedBlobs(documented(byCommand("log"), values, primary));
  return blob === atFork || produced.has(blob) ? "integrated" : "not integrated";
}

// Step 4, for a worktree copy that is not integrated: carry it when the primary copy equals the
// plan at the fork or a blob the worktree branch produced; otherwise the copies conflict.
function archiveHandoff({ primary, worktree, branch }) {
  const values = { "<branch>": branch, "<worktree>": worktree, "<plan path>": PLAN };
  values["<fork>"] = documented(byCommand("merge-base"), values, primary);
  const primaryBlob = git(primary, "hash-object", PLAN);
  const atFork = documented(byCommand("rev-parse"), values, primary);
  const produced = producedBlobs(documented(archiveLog, values, primary));
  return primaryBlob === atFork || produced.has(primaryBlob) ? "carry the worktree copy" : "plan: conflicting copies";
}

function write(file, content) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

// A primary checkout whose start transition assigned `p.md` to worktree `wt`. Blank lines keep
// edits at the top and bottom of the plan mergeable.
function started(name) {
  const primary = path.join(tempRoot, name, "main");
  write(path.join(primary, PLAN), "---\nid: p1\nworktree: wt\n---\n\n# Plan\n\n- [ ] task\n\n\n\n\n## Notes\n");
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
    assert.equal(integration(repo), "not integrated", "unmerged plan progress has not landed");

    const fork = git(repo.primary, "merge-base", "HEAD", "wt");
    git(repo.primary, "merge", "-q", "--squash", "wt");
    git(repo.primary, "commit", "-qm", "squash-merge wt");
    assert.equal(git(repo.primary, "merge-base", "HEAD", "wt"), fork, "a squash merge leaves the fork where it was, so only the produced blobs can match");
    assert.equal(integration(repo), "integrated", "a squash-merged plan is integrated");

    // A later step refuses and records its notes in the primary copy, committed or not.
    edit(repo.primary, "## Notes\n", "## Notes\n\nRefused: a Not tested entry is unconfirmed.\n");
    assert.equal(integration(repo), "integrated", "a refusal note in the primary copy does not block a rerun");
    git(repo.primary, "commit", "-qam", "plan-close notes");
    assert.equal(integration(repo), "integrated", "nor does a committed one");

    edit(repo.worktree, "# Plan", "# Plan, edited after the merge");
    assert.equal(integration(repo), "not integrated", "an uncommitted worktree edit after the merge has not landed");
    git(repo.worktree, "commit", "-qam", "edit after merge");
    assert.equal(integration(repo), "not integrated", "nor has a committed one");
  }

  // ---- A plan the worktree never edited is integrated, whatever happened on main ----
  {
    const repo = started("untouched");
    write(path.join(repo.worktree, "feature.txt"), "feature\n");
    git(repo.worktree, "add", ".");
    git(repo.worktree, "commit", "-qm", "implement");
    edit(repo.primary, "## Notes\n", "## Notes\n\nEdited on main.\n");
    git(repo.primary, "commit", "-qam", "edit on main");
    assert.equal(integration(repo), "integrated", "the worktree holds the plan at the fork, which main already had");
  }

  // ---- Archive handoff for abandoned work ----
  {
    const repo = started("abandoned");
    edit(repo.worktree, "- [ ] task", "- [x] task\n\nStopped: superseded by another approach.");
    git(repo.worktree, "commit", "-qam", "partial work");
    assert.equal(integration(repo), "not integrated");
    assert.equal(archiveHandoff(repo), "carry the worktree copy", "an untouched primary copy equals the plan at the fork");

    edit(repo.primary, "## Notes\n", "## Notes\n\nEdited on main.\n");
    assert.equal(archiveHandoff(repo), "plan: conflicting copies", "an uncommitted outside edit on main refuses the handoff");
    git(repo.primary, "commit", "-qam", "edit on main");
    assert.equal(archiveHandoff(repo), "plan: conflicting copies", "so does a committed one");

    git(repo.worktree, "merge", "-q", "--no-edit", "main");
    assert.equal(archiveHandoff(repo), "carry the worktree copy", "merging main into the worktree resolves it");
  }

  // ---- A completed plan commits alone while unrelated staged work stays staged ----
  {
    const repo = started("close-commit");
    const completed = "docs/plans/completed/p.md";
    write(path.join(repo.primary, "other.txt"), "before\n");
    git(repo.primary, "add", "other.txt");
    git(repo.primary, "commit", "-qm", "other baseline");
    write(path.join(repo.primary, "other.txt"), "staged unrelated work\n");
    git(repo.primary, "add", "other.txt");
    edit(repo.primary, "- [ ] task", "- [x] task");
    fs.mkdirSync(path.join(repo.primary, "docs/plans/completed"), { recursive: true });
    git(repo.primary, "mv", PLAN, completed);
    git(repo.primary, "commit", "--only", "-m", "Close plan p1", "--", PLAN, completed);
    assert.deepEqual(git(repo.primary, "diff-tree", "--no-commit-id", "--name-only", "-r", "HEAD").split("\n"),
      [PLAN, completed], "the close commit contains only the plan move");
    assert.equal(git(repo.primary, "diff", "--cached", "--name-only"), "other.txt",
      "unrelated staged work remains staged");
    assert.equal(fs.readFileSync(path.join(repo.primary, "other.txt"), "utf8"), "staged unrelated work\n");
  }

  console.log("plan-close integration commands: ok");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
