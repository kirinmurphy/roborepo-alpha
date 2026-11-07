#!/usr/bin/env node
// The plans store end to end through the real CLI: one remote branch holding every plan, a rebuildable
// worktree per clone, automatic push, offline saves, and what two clones do to each other.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { withInvalidatedApproval } from "../../modules/plan-suite/plan-writes.mjs";
import { createPlanFixture, planDoc } from "./lib/plan-git-fixture.mjs";

const fx = createPlanFixture("roborepo-plan-store-");
const { git, roborepo, json, repository, initStore, storePath, clone, worktree, tmp } = fx;
const run = (cwd, ...args) => roborepo(["plans", ...args, "--json"], { cwd });
const ok = (result, label) => {
  assert.equal(result.status, 0, `${label}\n${result.stdout}${result.stderr}`);
  return json(result, label);
};
const refused = (result, label, pattern) => {
  assert.equal(result.status, 1, `${label} refuses\n${result.stdout}${result.stderr}`);
  const body = json(result, label);
  assert.match(`${body.error.message}\n${body.error.resolution || ""}`, pattern, label);
  return body;
};
const source = (name, text) => {
  const file = path.join(tmp, "drafts", String(Math.random()).slice(2), name);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text);
  return file;
};
const remoteHas = (root, file) => fx.tryGit(root, "ls-remote", "--exit-code", "origin", "refs/heads/repo-plans").status === 0
  && fx.tryGit(root, "cat-file", "-e", `refs/remotes/origin/repo-plans:${file}`).status === 0;

try {
  // ---- init
  const root = repository("repo", { "src/app.txt": "code\n" }, { store: false });
  const noPlans = roborepo(["plans", "validate", "--json"], { cwd: root });
  refused(noPlans, "a repo with no store", /plans init/);

  const noOrigin = path.join(tmp, "no-origin");
  git(tmp, "init", "--quiet", "--initial-branch=main", noOrigin);
  refused(run(noOrigin, "init"), "init without origin", /origin/);

  // A home-relative root, so a second machine (another HOME) resolves the same config elsewhere.
  const first = ok(run(root, "init", "--worktree-root", "~/plan-worktrees", "--repo-name", "repo"), "init");
  assert.equal(first.state, "created");
  assert.equal(first.synchronized, true);
  const store = storePath(root);
  assert.equal(path.basename(store), "repo_plans");
  assert.equal(git(root, "rev-parse", "--abbrev-ref", "HEAD"), "main", "init does not move the code checkout");
  for (const folder of ["backlog", "ready", "active", "review", "completed", "archived"]) assert.ok(fs.existsSync(path.join(store, "plans", folder)), folder);
  assert.ok(fs.existsSync(path.join(store, "plans/plans-config.json")));
  assert.ok(git(root, "worktree", "list", "--porcelain").includes("locked"), "the reserved worktree is locked");
  assert.ok(remoteHas(root, "plans/plans-config.json"), "the scaffold reached the remote");

  const head = git(store, "rev-parse", "HEAD");
  const second = initStore(root);
  assert.equal(second.changed, false, "a second init changes nothing");
  assert.equal(git(store, "rev-parse", "HEAD"), head);

  // ---- save, from a linked worktree, without touching either checkout
  const wt = worktree(root, "feat/one");
  const statusBefore = [git(root, "status", "--porcelain"), git(wt.path, "status", "--porcelain")];
  const saved = ok(run(wt.path, "save", source("test-alpha.md", planDoc({ id: "alpha001" }))), "save a new plan");
  assert.equal(saved.action, "create");
  assert.equal(saved.path, "plans/backlog/test-alpha.md");
  assert.equal(saved.synchronized, true);
  assert.deepEqual([git(root, "status", "--porcelain"), git(wt.path, "status", "--porcelain")], statusBefore);
  assert.ok(remoteHas(root, "plans/backlog/test-alpha.md"), "the save reached the remote");

  const noId = ok(run(root, "save", source("test-noid.md", planDoc({ id: "x" }).replace("id: x\n", ""))), "a plan with no id");
  assert.match(noId.id, /^[0-9a-z]{8}$/, "gets a generated id");

  // ---- save refusals
  const alpha = fs.readFileSync(path.join(store, "plans/backlog/test-alpha.md"), "utf8");
  refused(run(root, "save", source("test-alpha.md", alpha.replace("id: alpha001", "id: other999"))), "a changed id", /already the filename/);
  refused(run(root, "save", source("renamed.md", alpha.replace("worktree:", "worktree: wt"))), "a changed worktree", /worktree/);
  refused(run(root, "save", source("renamed.md", `${alpha}\n## Review\n\n### Approval\n- Decision: approved\n`)), "an added approval", /Approval/);
  const renamed = ok(run(root, "save", source("any-name.md", `${alpha}\nMore.\n`)), "an update under another filename");
  assert.equal(renamed.path, "plans/backlog/test-alpha.md", "keeps its path");

  // ---- hooks never run on store commits
  const hooks = path.join(tmp, "failing-hooks");
  fs.mkdirSync(hooks, { recursive: true });
  for (const hook of ["pre-commit", "pre-push"]) fs.writeFileSync(path.join(hooks, hook), "#!/bin/sh\nexit 1\n", { mode: 0o755 });
  git(root, "config", "core.hooksPath", hooks);
  ok(run(root, "save", source("test-hooked.md", planDoc({ id: "hook0001" }))), "a save past failing hooks");
  git(root, "config", "--unset", "core.hooksPath");

  // ---- lifecycle moves commit to the plans branch and leave code alone
  const mainHead = git(root, "rev-parse", "main");
  ok(run(wt.path, "promote", "alpha001"), "promote");
  assert.throws(() => git(root, "cat-file", "-e", "main:plans/ready/test-alpha.md"));
  refused(run(root, "start", "alpha001", "--worktree", "repo_plans"), "start in the reserved worktree", /reserved/);
  const started = ok(run(root, "start", "alpha001", "--worktree", wt.name), "start");
  assert.equal(started.verdict, "APPROVED");
  assert.equal(started.synchronized, true);
  assert.equal(git(root, "rev-parse", "main"), mainHead, "a transition commits nothing on main");

  // ---- show, approve, and an approval that plan commits cannot stale
  const shown = ok(run(wt.path, "show", "alpha001"), "show");
  assert.equal(shown.lifecycle, "active");
  assert.match(shown.markdown, /worktree: feat-one/);
  fx.commit(wt.path, "implement", { "src/new.txt": "new\n" });
  const tip = git(wt.path, "rev-parse", "HEAD");
  refused(run(root, "approve", "alpha001", "--commit", "abc", "--confirmed-by", "human"), "a short commit id", /full commit/);
  ok(run(root, "approve", "alpha001", "--commit", tip, "--confirmed-by", "human"), "approve");
  const approved = fs.readFileSync(path.join(store, "plans/active/test-alpha.md"), "utf8");
  assert.match(approved, new RegExp(`### Approval\\n- Decision: approved\\n- Reviewed implementation commit: ${tip}\\n- Confirmed by: human`));
  const fresh = roborepo(["plans", "approval", "alpha001", "--json"], { cwd: root });
  assert.equal(json(fresh, "approval").state, "fresh");
  assert.match(withInvalidatedApproval(approved), new RegExp(`### Approval\\n- Decision: invalidated\\n- Reviewed implementation commit: ${tip}`), "invalidating keeps the record as history");
  assert.equal(withInvalidatedApproval("# No review\n"), "# No review\n", "a plan with no approval is left alone");
  ok(run(root, "save", source("test-alpha.md", approved.replace("The thing is done.", "The thing is done. A later note."))), "a plan-only save after approval");
  assert.equal(json(roborepo(["plans", "approval", "alpha001", "--json"], { cwd: root }), "approval").state, "fresh", "a plans commit leaves the approval fresh");

  // ---- a fresh clone exposes existing plans; a missing checkout recovers
  const other = clone(root, "machine-b");
  fs.mkdirSync(path.join(tmp, "home-b"));
  ok(roborepo(["plans", "init", "--json"], { cwd: other, env: { HOME: path.join(tmp, "home-b") } }), "init on a second machine");
  const otherStore = storePath(other);
  assert.notEqual(otherStore, store);
  ok(run(other, "show", "alpha001"), "a fresh clone reads an existing plan");
  const missingWorktree = ok(run(other, "show", "alpha001"), "the plan whose worktree this machine lacks");
  assert.equal(missingWorktree.lifecycle, "active");
  assert.equal(roborepo(["plans", "preflight", "alpha001", "--json"], { cwd: other }).status, 1, "preflight refuses without the worktree");
  assert.equal(roborepo(["plans", "landed", "alpha001", "--json"], { cwd: other }).status, 1, "landed refuses without the worktree");

  // ---- two clones: different plans both land
  ok(run(root, "save", source("test-from-a.md", planDoc({ id: "froma001" }))), "clone A saves");
  ok(run(other, "save", source("test-from-b.md", planDoc({ id: "fromb001" }))), "clone B saves another plan");
  git(store, "fetch", "--quiet", "origin");
  assert.ok(fx.tryGit(store, "cat-file", "-e", "origin/repo-plans:plans/backlog/test-from-a.md").status === 0);
  assert.ok(fx.tryGit(store, "cat-file", "-e", "origin/repo-plans:plans/backlog/test-from-b.md").status === 0);

  // ---- two clones: the same plan is refused for the second, whose source is untouched
  ok(run(other, "show", "froma001"), "B reads A's plan");
  const aText = fs.readFileSync(path.join(store, "plans/backlog/test-from-a.md"), "utf8");
  ok(run(root, "save", source("test-from-a.md", `${aText}\nA's edit.\n`)), "A edits");
  const bEdit = source("test-from-a.md", `${aText}\nB's edit.\n`);
  refused(run(other, "save", bEdit), "B's stale edit", /Another clone changed this plan/);
  assert.match(fs.readFileSync(bEdit, "utf8"), /B's edit/, "B's edit is preserved");
  assert.doesNotMatch(fs.readFileSync(path.join(otherStore, "plans/backlog/test-from-a.md"), "utf8"), /B's edit/);

  // ---- ordering from two clones keeps both ids
  ok(run(root, "config", "namespaces", source("ns.json", JSON.stringify({ test: "Fixture plans." }))), "declare a namespace");
  ok(run(other, "show", "froma001"), "B catches up");
  ok(run(root, "order", "place", "froma001", "--top"), "A places a plan");
  ok(run(other, "order", "place", "fromb001", "--bottom"), "B places another");
  git(store, "fetch", "--quiet", "origin");
  const order = JSON.parse(git(store, "show", "origin/repo-plans:plans/plans-order.json"));
  assert.ok(order.namespaces.test.includes("froma001") && order.namespaces.test.includes("fromb001"), `both ids land: ${JSON.stringify(order)}`);

  // ---- an unreachable remote keeps the commit, reports it, and the next reachable mutation pushes it
  const url = git(root, "remote", "get-url", "origin");
  git(root, "remote", "set-url", "origin", path.join(tmp, "nowhere.git"));
  const offline = ok(run(root, "save", source("test-offline.md", planDoc({ id: "off00001" }))), "an offline save exits 0");
  assert.equal(offline.synchronized, false);
  assert.ok(offline.commit, "keeps the commit");
  refused(run(root, "init"), "init never reports local-only success", /could not be reached/);
  git(root, "remote", "set-url", "origin", url);
  const back = ok(run(root, "save", source("test-online.md", planDoc({ id: "onl00001" }))), "the next reachable save");
  assert.equal(back.synchronized, true);
  git(otherStore, "fetch", "--quiet", "origin");
  assert.equal(fx.tryGit(otherStore, "cat-file", "-e", "origin/repo-plans:plans/backlog/test-offline.md").status, 0, "the pending commit was pushed");

  // ---- an offline edit overlapping a remote change stops and discards nothing
  ok(run(root, "show", "onl00001"), "A up to date");
  ok(run(other, "show", "onl00001"), "B up to date");
  const onl = fs.readFileSync(path.join(store, "plans/backlog/test-online.md"), "utf8");
  git(root, "remote", "set-url", "origin", path.join(tmp, "nowhere.git"));
  const pending = ok(run(root, "save", source("test-online.md", `${onl}\nOffline edit.\n`)), "an offline edit");
  git(root, "remote", "set-url", "origin", url);
  ok(run(other, "save", source("test-online.md", `${onl}\nRemote edit.\n`)), "the same plan elsewhere");
  refused(run(root, "save", source("test-after.md", planDoc({ id: "aft00001" }))), "the next mutation", /Rebase|Resolve/);
  assert.equal(git(store, "rev-parse", "HEAD"), pending.commit, "the pending commit is still there");

  // ---- an uncommitted edit to an affected path refuses; the store's other files don't
  const another = repository("dirty", { "plans/backlog/test-dirty.md": planDoc({ id: "dirty001" }) });
  const dirtyStore = storePath(another);
  fs.appendFileSync(path.join(dirtyStore, "plans/backlog/test-dirty.md"), "raw edit\n");
  const dirtyText = fs.readFileSync(path.join(dirtyStore, "plans/backlog/test-dirty.md"), "utf8");
  refused(run(another, "save", source("test-dirty.md", `${dirtyText}more\n`)), "a raw edit to the saved plan", /uncommitted edits/);
  ok(run(another, "save", source("test-clean.md", planDoc({ id: "clean001" }))), "a different plan still saves");

  // ---- an occupied destination is never replaced
  const third = repository("third", {}, { store: false });
  const occupied = path.join(tmp, "worktree-root", "shared", "repo_plans");
  fs.mkdirSync(occupied, { recursive: true });
  fs.writeFileSync(path.join(occupied, "keep.txt"), "someone else's\n");
  refused(run(third, "init", "--worktree-root", path.join(tmp, "worktree-root"), "--repo-name", "shared"), "an occupied path", /already in use/);
  assert.equal(fs.readFileSync(path.join(occupied, "keep.txt"), "utf8"), "someone else's\n");

  // ---- a missing local checkout is rebuilt from the remote
  const rebuilt = repository("rebuilt", { "plans/backlog/test-kept.md": planDoc({ id: "kept0001" }) });
  fs.rmSync(storePath(rebuilt), { recursive: true, force: true });
  refused(run(rebuilt, "validate"), "a missing checkout", /plans init/);
  assert.equal(initStore(rebuilt, "rebuilt").state, "recovered");
  ok(run(rebuilt, "show", "kept0001"), "the plan is back");

  console.log("plan-store-check: ok");
} finally {
  fx.cleanup();
}
