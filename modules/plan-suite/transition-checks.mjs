// The six post-commit checks every lifecycle transition must pass before it is reported as done.
// Each fact is read fresh from disk and Git: values remembered from the transition do not count,
// because another session may have moved the store in between. A failed check carries the observed
// value and the action that fixes it; the caller approves only when all six pass.
import { parseFrontmatter } from "./index.mjs";
import { PLANS_BRANCH } from "./plan-store.mjs";
import { dirtyPaths, git, worktreeName } from "./plan-git.mjs";

// `root` is the plans worktree. `worktree` is { name, path } for the start transition, which also
// records the plan's implementation worktree. `dependentPaths` are the other plans an archive edited,
// the only files besides the plan it may touch.
export function validateTransition({ root, id, fromPath, toPath, commit, worktree = null, bodyUnchanged = false, dependentPaths = [] }) {
  const checks = [];
  const check = (n, name, ok, observed, fix) => checks.push({ n, name, ok, observed, ...(ok ? {} : { fix }) });
  const moved = fromPath !== toPath;
  const lifecycle = toPath.split("/")[1];

  const tracked = git(root, ["ls-files", "--", toPath]).stdout;
  const leftBehind = moved ? git(root, ["ls-files", "--", fromPath]).stdout : "";
  check(1, `plan is in ${lifecycle}/`, tracked === toPath && !leftBehind, leftBehind ? `${tracked || "(untracked)"}; ${leftBehind} still tracked` : tracked || "(untracked)",
    `run the transition again; the plan must sit in plans/${lifecycle}/ on ${PLANS_BRANCH}`);

  const committed = git(root, ["show", `HEAD:${toPath}`]);
  const frontmatter = committed.ok ? parseFrontmatter(committed.stdout).frontmatter : {};
  const recordedId = String(frontmatter.id || "");
  const recordedWorktree = String(frontmatter.worktree || "");
  const targetName = worktree ? worktreeName(worktree.path) : "";
  const fieldsOk = recordedId === id && (!worktree || (recordedWorktree === worktree.name && recordedWorktree === targetName));
  check(2, worktree ? "id and worktree are recorded" : "id is recorded", fieldsOk,
    worktree ? `id=${recordedId || "(empty)"} committed=${recordedWorktree || "(empty)"} target=${targetName || "(unresolved)"}` : `id=${recordedId || "(empty)"}`,
    worktree ? `run \`roborepo plans start\` again with --worktree ${targetName}` : `restore \`id: ${id}\` in ${toPath} with \`roborepo plans save\``);

  const diff = git(root, ["diff", "--quiet", "HEAD", "--", toPath]);
  check(3, "transition is committed", diff.ok, diff.ok ? "working file matches committed blob" : "working file differs from committed blob",
    `discard the uncommitted edit to ${toPath} in the plans worktree`);

  if (commit) {
    // Rename detection is a similarity guess: a transition that carries heavy edits falls below Git's
    // threshold and reads as a delete plus an add. Compare exact paths instead, so a move is the old
    // path deleted and the new one added.
    const touched = git(root, ["show", "--name-status", "--no-renames", "--format=", commit]).stdout.split("\n").filter(Boolean);
    const expected = moved ? [fromPath, toPath] : [toPath];
    const planChanges = [...(moved ? [`D\t${fromPath}`, `A\t${toPath}`] : [`M\t${toPath}`]), ...dependentPaths.map((item) => `M\t${item}`)];
    const onlyPlan = touched.length === planChanges.length && planChanges.every((line) => touched.includes(line));
    const before = git(root, ["show", `${commit}^:${fromPath}`]);
    const after = git(root, ["show", `${commit}:${toPath}`]);
    const bodyOk = !bodyUnchanged || (before.ok && after.ok && parseFrontmatter(before.stdout).body === parseFrontmatter(after.stdout).body);
    check(4, "transition commit touches only the plan", onlyPlan && bodyOk,
      `${touched.join("; ") || "(no paths)"}${bodyOk ? "" : "; body changed"}`,
      `revert ${commit.slice(0, 12)} with Git in the plans worktree and redo the transition so it changes only the plan (${moved ? "a rename" : "a modification"} of ${expected.join(" -> ")})`);
  } else {
    check(4, "transition commit touches only the plan", true, "already recorded; no commit made");
  }

  const pending = dirtyPaths(root, [...(moved ? [fromPath, toPath] : [toPath]), ...dependentPaths]);
  check(5, "no plan-transition diff remains", pending.length === 0, pending.join("; ") || "(clean)",
    "discard the remaining change to the plan in the plans worktree");

  const branch = git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]).stdout;
  check(6, `the plans worktree is on ${PLANS_BRANCH}`, branch === PLANS_BRANCH, branch || "(detached)",
    `finish what is in progress in the plans worktree, then return it to ${PLANS_BRANCH}`);

  return checks;
}
