// The six post-commit checks every lifecycle transition must pass before it is reported as done.
// Each fact is read fresh from disk and Git: values remembered from the transition do not count,
// because another session may have moved the checkout in between. A failed check carries the
// observed value and the action that fixes it; the caller approves only when all six pass.
import { parseFrontmatter } from "./index.mjs";
import { dirtyPaths, git, topLevel, worktreeName } from "./plan-git.mjs";

// `worktree` is { name, path } for the start transition, which also records the plan's worktree.
export function validateTransition({ cwd, primary, base, id, fromPath, toPath, commit, worktree = null, bodyUnchanged = false }) {
  const checks = [];
  const check = (n, name, ok, observed, fix) => checks.push({ n, name, ok, observed, ...(ok ? {} : { fix }) });
  const moved = fromPath !== toPath;
  const lifecycle = toPath.split("/")[2];

  const tracked = git(primary, ["ls-files", "--", toPath]).stdout;
  const leftBehind = moved ? git(primary, ["ls-files", "--", fromPath]).stdout : "";
  check(1, `plan is in ${lifecycle}/`, tracked === toPath && !leftBehind, leftBehind ? `${tracked || "(untracked)"}; ${leftBehind} still tracked` : tracked || "(untracked)",
    `git mv the plan into docs/plans/${lifecycle}/ and commit it on ${base}`);

  const committed = git(primary, ["show", `${base}:${toPath}`]);
  const frontmatter = committed.ok ? parseFrontmatter(committed.stdout).frontmatter : {};
  const recordedId = String(frontmatter.id || "");
  const recordedWorktree = String(frontmatter.worktree || "");
  const targetName = worktree ? worktreeName(worktree.path) : "";
  const fieldsOk = recordedId === id && (!worktree || (recordedWorktree === worktree.name && recordedWorktree === targetName));
  check(2, worktree ? "id and worktree are recorded" : "id is recorded", fieldsOk,
    worktree ? `id=${recordedId || "(empty)"} committed=${recordedWorktree || "(empty)"} target=${targetName || "(unresolved)"}` : `id=${recordedId || "(empty)"}`,
    worktree ? `set \`worktree: ${targetName}\` in ${toPath} and commit it on ${base}` : `restore \`id: ${id}\` in ${toPath} and commit it on ${base}`);

  const diff = git(primary, ["diff", "--quiet", base, "--", toPath]);
  check(3, "transition is committed", diff.ok, diff.ok ? "working file matches committed blob" : "working file differs from committed blob",
    `commit ${toPath} on ${base}, or discard the uncommitted edit`);

  if (commit) {
    const touched = git(primary, ["show", "--name-status", "--format=", commit]).stdout.split("\n").filter(Boolean);
    const [status = "", ...paths] = (touched[0] || "").split("\t");
    const expected = moved ? [fromPath, toPath] : [toPath];
    const onlyPlan = touched.length === 1 && status[0] === (moved ? "R" : "M") && paths.join("\t") === expected.join("\t");
    const before = git(primary, ["show", `${commit}^:${fromPath}`]);
    const after = git(primary, ["show", `${commit}:${toPath}`]);
    const bodyOk = !bodyUnchanged || (before.ok && after.ok && parseFrontmatter(before.stdout).body === parseFrontmatter(after.stdout).body);
    check(4, "transition commit touches only the plan", onlyPlan && bodyOk,
      `${touched.join("; ") || "(no paths)"}${bodyOk ? "" : "; body changed"}`,
      `revert ${commit.slice(0, 12)} and redo the transition so it changes only the plan (${moved ? "a rename" : "a modification"} of ${expected.join(" -> ")})`);
  } else {
    check(4, "transition commit touches only the plan", true, "already recorded; no commit made");
  }

  const pending = dirtyPaths(primary, moved ? [fromPath, toPath] : [toPath]);
  check(5, "no plan-transition diff remains", pending.length === 0, pending.join("; ") || "(clean)",
    "commit or discard the remaining change to the plan in the primary checkout");

  const here = topLevel(cwd);
  check(6, "execution is in the primary checkout", here === primary, here || "(not a Git checkout)",
    `run from ${primary}, not from a linked worktree`);

  return checks;
}
