// The plan-start transition: record which linked worktree implements a plan, commit that fact to
// the canonical plan on the base branch, and prove the result from fresh Git state.
//
// This is the one place the transition's rules live. `plan-start` runs it through
// `roborepo plans start`; the skill keeps only the judgment calls around it (confirming
// worktreeRoot on a first run, deciding whether an existing worktree is safe to reuse).
//
// Unlike modules/repositories/git-exec.mjs, which is read-only by design, this module mutates the
// primary checkout: `git mv`, one plan-only commit, and a fast-forward of the target branch. Every
// mutation is preceded by a precondition that refuses rather than working around a surprise.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  buildRepositoryPlanSnapshot,
  domainError,
  lifecycleMoveDestination,
  parseFrontmatter,
  selectRepositoryPlan,
  writeFrontmatterField,
} from "./index.mjs";

const GIT_TIMEOUT_MS = 60_000;

export function startPlan({ cwd = process.cwd(), selector, worktree, base = "main" }) {
  if (!selector) throw domainError("INVALID_CHANGE", "A plan id or path is required.");
  if (!worktree) throw domainError("INVALID_CHANGE", "A worktree name is required (--worktree <name>).");

  const primary = primaryCheckout(cwd);
  assertRunningInPrimary(cwd, primary);
  assertCleanBaseBranch(primary, base);
  const target = findLinkedWorktree(primary, worktree);

  const snapshot = buildRepositoryPlanSnapshot({ cwd: primary });
  const record = selectRepositoryPlan(snapshot, selector, { cwd });
  const { lifecycle, relativePath } = record.plan;
  if (lifecycle !== "backlog" && lifecycle !== "active") {
    throw domainError("INVALID_CHANGE", `Only a backlog or active plan can be started; this one is ${lifecycle}.`, {
      details: [relativePath],
    });
  }

  const baseBefore = git(primary, ["rev-parse", base]).stdout;
  const activePath = lifecycle === "active"
    ? relativePath
    : path.relative(primary, lifecycleMoveDestination(fs.realpathSync(primary), fs.realpathSync(record.absolutePath), "active").destination);

  let commit = null;
  if (alreadyRecorded(primary, base, activePath, worktree)) {
    // Nothing to commit: the base branch already carries exactly this association.
  } else {
    if (lifecycle === "backlog") gitOrThrow(primary, ["mv", "--", relativePath, activePath]);
    const absolute = path.join(primary, activePath);
    fs.writeFileSync(absolute, writeFrontmatterField(fs.readFileSync(absolute, "utf8"), "worktree", worktree));
    const paths = lifecycle === "backlog" ? [relativePath, activePath] : [activePath];
    gitOrThrow(primary, ["add", "--", activePath]);
    gitOrThrow(primary, ["commit", "--quiet", "-m", `Start plan ${record.plan.id || relativePath} in worktree ${worktree}`, "--", ...paths]);
    commit = git(primary, ["rev-parse", "HEAD"]).stdout;
  }

  const fastForward = fastForwardTarget(target.path, base, baseBefore);
  const checks = validateStartTransition({ cwd, primary, base, activePath, worktree, targetPath: target.path, commit, movedFrom: lifecycle === "backlog" ? relativePath : null });
  return {
    verdict: checks.every((check) => check.ok) ? "APPROVED" : "REFUSED",
    plan: { id: record.plan.id, from: relativePath, path: activePath },
    worktree: { name: worktree, path: target.path, branch: target.branch },
    base,
    commit,
    alreadyRecorded: commit === null,
    fastForward,
    staleLinks: linksToPath(primary, relativePath === activePath ? null : relativePath),
    checks,
  };
}

// The six validator checks, each read fresh from disk and Git. A check that fails carries the
// observed value and the action that fixes it; the caller approves only when all pass.
export function validateStartTransition({ cwd, primary, base, activePath, worktree, targetPath, commit, movedFrom }) {
  const checks = [];
  const check = (n, name, ok, observed, fix) => checks.push({ n, name, ok, observed, ...(ok ? {} : { fix }) });

  const tracked = git(primary, ["ls-files", "--", activePath]).stdout;
  check(1, "plan is in active/", activePath.startsWith("docs/plans/active/") && tracked === activePath, tracked || "(untracked)",
    `git mv the plan into docs/plans/active/ and commit it on ${base}`);

  const committed = git(primary, ["show", `${base}:${activePath}`]);
  const recorded = committed.ok ? String(parseFrontmatter(committed.stdout).frontmatter.worktree || "") : "";
  const targetName = path.basename(git(targetPath, ["rev-parse", "--absolute-git-dir"]).stdout);
  check(2, "worktree matches the target", Boolean(recorded) && recorded === worktree && recorded === targetName,
    `committed=${recorded || "(empty)"} target=${targetName || "(unresolved)"}`,
    `set \`worktree: ${targetName}\` in ${activePath} and commit it on ${base}`);

  const diff = git(primary, ["diff", "--quiet", base, "--", activePath]);
  check(3, "transition is committed", diff.ok, diff.ok ? "working file matches committed blob" : "working file differs from committed blob",
    `commit ${activePath} on ${base}, or discard the uncommitted edit`);

  if (commit) {
    const touched = git(primary, ["show", "--name-status", "--format=", commit]).stdout.split("\n").filter(Boolean);
    const [status = "", ...paths] = (touched[0] || "").split("\t");
    const expectedPaths = movedFrom ? [movedFrom, activePath] : [activePath];
    const onlyPlan = touched.length === 1
      && status[0] === (movedFrom ? "R" : "M")
      && paths.join("\t") === expectedPaths.join("\t");
    const before = git(primary, ["show", `${commit}^:${movedFrom || activePath}`]);
    const after = git(primary, ["show", `${commit}:${activePath}`]);
    const bodyUnchanged = before.ok && after.ok && parseFrontmatter(before.stdout).body === parseFrontmatter(after.stdout).body;
    check(4, "transition commit touches only the plan", onlyPlan && bodyUnchanged,
      `${touched.join("; ") || "(no paths)"}${bodyUnchanged ? "" : "; body changed"}`,
      `revert ${commit.slice(0, 12)} and redo the transition so it changes only the plan's frontmatter (${movedFrom ? "a rename" : "a modification"} of ${expectedPaths.join(" -> ")})`);
  } else {
    check(4, "transition commit touches only the plan", true, "already recorded; no commit made");
  }

  const pending = git(primary, ["status", "--porcelain", "--", "docs/plans"]).stdout;
  check(5, "no plan-transition diff remains", pending === "", pending || "(clean)",
    "commit or discard the remaining docs/plans changes in the primary checkout");

  const here = topLevel(cwd);
  check(6, "execution is in the primary checkout", here === primary, here || "(not a Git checkout)",
    `run from ${primary}, not from the target worktree`);

  return checks;
}

function alreadyRecorded(primary, base, activePath, worktree) {
  const committed = git(primary, ["show", `${base}:${activePath}`]);
  if (!committed.ok) return false;
  if (String(parseFrontmatter(committed.stdout).frontmatter.worktree || "") !== worktree) return false;
  return git(primary, ["diff", "--quiet", base, "--", activePath]).ok;
}

// Brings a worktree branch that has no commits of its own up to the transition commit, so the
// branch carries the canonical plan state. A branch with its own commits, or uncommitted edits, is
// left alone: its copy of the plan predates the transition and the result says so.
function fastForwardTarget(targetPath, base, baseBefore) {
  const head = git(targetPath, ["rev-parse", "HEAD"]).stdout;
  if (head === git(targetPath, ["rev-parse", base]).stdout) return { applied: false, reason: "already at the base branch" };
  const ownCommits = Number(git(targetPath, ["rev-list", "--count", `${base}..HEAD`]).stdout || "0");
  if (ownCommits > 0) return { applied: false, reason: "worktree branch has its own commits; its plan copy predates the transition" };
  if (git(targetPath, ["status", "--porcelain"]).stdout) return { applied: false, reason: "worktree has uncommitted changes; its plan copy predates the transition" };
  const merged = git(targetPath, ["merge", "--ff-only", "--quiet", base]);
  if (!merged.ok) return { applied: false, reason: `fast-forward failed: ${merged.stderr}` };
  return { applied: true, from: head || baseBefore };
}

export function primaryCheckout(cwd) {
  const list = git(cwd, ["worktree", "list", "--porcelain"]);
  if (!list.ok) throw domainError("INVALID_CHANGE", "Not inside a Git repository.", { details: [list.stderr] });
  const first = /^worktree (.+)$/m.exec(list.stdout);
  return fs.realpathSync(first[1]);
}

function assertRunningInPrimary(cwd, primary) {
  const here = topLevel(cwd);
  if (here !== primary) {
    throw domainError("INVALID_CHANGE", "Run plans start from the primary checkout.", {
      resolution: `cd ${primary} and run it again; the transition commits to the base branch there.`,
      details: [`current checkout: ${here}`],
    });
  }
}

function assertCleanBaseBranch(primary, base) {
  const branch = git(primary, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
  if (branch !== base) {
    throw domainError("INVALID_CHANGE", `The primary checkout is on ${branch || "a detached HEAD"}, not ${base}.`, {
      resolution: "Ask the user before switching branches; the transition commits only on the base branch.",
    });
  }
  const status = git(primary, ["status", "--porcelain"]).stdout;
  if (status) {
    throw domainError("INVALID_CHANGE", "The primary checkout has uncommitted changes.", {
      resolution: "Ask the user how to handle them; a checkout with someone else's edits is not eligible for an automated commit.",
      details: status.split("\n"),
    });
  }
}

// Finds the linked worktree whose Git administrative name (`.git/worktrees/<name>`) is `name`. The
// main checkout has no administrative name and can never match.
export function findLinkedWorktree(primary, name) {
  const entries = git(primary, ["worktree", "list", "--porcelain"]).stdout.split("\n\n").slice(1);
  for (const entry of entries) {
    const worktreePath = /^worktree (.+)$/m.exec(entry)?.[1];
    if (!worktreePath || !fs.existsSync(worktreePath)) continue;
    const adminName = path.basename(git(worktreePath, ["rev-parse", "--absolute-git-dir"]).stdout);
    if (adminName === name) {
      return { path: fs.realpathSync(worktreePath), branch: (/^branch refs\/heads\/(.+)$/m.exec(entry)?.[1]) || null };
    }
  }
  throw domainError("PLAN_NOT_FOUND", `No linked worktree is named ${name}.`, {
    resolution: "Pass the worktree's Git administrative name: basename of `git -C <worktree> rev-parse --absolute-git-dir`.",
  });
}

// Files that still name the plan's old path. Reported, never edited here: rewriting them would put
// files other than the plan into the plan-only transition commit.
function linksToPath(primary, oldPath) {
  if (!oldPath) return [];
  const found = git(primary, ["grep", "-l", "-F", "--", oldPath]);
  return found.ok ? found.stdout.split("\n").filter(Boolean) : [];
}

function topLevel(cwd) {
  const result = git(cwd, ["rev-parse", "--show-toplevel"]);
  return result.ok ? fs.realpathSync(result.stdout) : "";
}

function git(cwd, args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8", timeout: GIT_TIMEOUT_MS });
  return { ok: result.status === 0, stdout: (result.stdout || "").trim(), stderr: (result.stderr || "").trim() };
}

function gitOrThrow(cwd, args) {
  const result = git(cwd, args);
  if (!result.ok) throw domainError("MOVE_FAILED", `git ${args[0]} failed.`, { details: [result.stderr] });
  return result;
}
