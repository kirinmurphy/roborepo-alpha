#!/usr/bin/env node
// The plans store end to end through the real CLI: one remote branch holding every plan, a rebuildable
// worktree per clone, automatic push, offline saves, and what two clones do to each other.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { addRepositorySource } from "../cli/repository-sources.mjs";
import { startHermeticPortal } from "./lib/portal-cleanup.mjs";
import { withInvalidatedApproval } from "../../modules/plan-suite/plan-writes.mjs";
import { mergeOrder } from "../../modules/plan-suite/plan-store.mjs";
import { domainError } from "../../modules/plan-suite/index.mjs";
import { withoutStorePath } from "../cli/plans.mjs";
import { linkedWorktrees } from "../../modules/repositories/worktree-inventory.mjs";
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

  // ---- a reftable repository: refs live in binary tables, and every HEAD file holds a placeholder
  if (fx.tryGit(tmp, "init", "--quiet", "--ref-format=reftable", path.join(tmp, "reftable-probe")).status === 0) {
    const reftable = repository("reftable", { "plans/backlog/test-table.md": planDoc({ id: "table001" }) }, { refFormat: "reftable" });
    assert.equal(git(reftable, "rev-parse", "--show-ref-format"), "reftable");
    const tableStore = storePath(reftable);
    assert.equal(git(tableStore, "rev-parse", "--show-ref-format"), "reftable");
    assert.equal(initStore(reftable).changed, false, "init finds its worktree again");
    const tableWt = worktree(reftable, "feat/table");
    assert.equal(linkedWorktrees(path.join(reftable, ".git")).map((item) => item.branch).join(), "feat/table", "the store stays hidden, and the code branch reads correctly");
    ok(run(tableWt.path, "promote", "table001"), "promote in a reftable repository");
    assert.equal(ok(run(tableWt.path, "start", "table001", "--worktree", tableWt.name), "start in a reftable repository").synchronized, true);
    fx.commit(tableWt.path, "implement", { "src/table.txt": "table\n" });
    git(tableWt.path, "checkout", "--quiet", "--detach");
    assert.equal(linkedWorktrees(path.join(reftable, ".git"))[0].detached, true, "a moved HEAD is read again, not from the cache");
    git(tableWt.path, "checkout", "--quiet", "feat/table");
    ok(run(reftable, "approve", "table001", "--commit", git(tableWt.path, "rev-parse", "HEAD"), "--confirmed-by", "human"), "approve in a reftable repository");
    assert.equal(json(roborepo(["plans", "approval", "table001", "--json"], { cwd: reftable }), "approval").state, "fresh");
    assert.ok(remoteHas(reftable, "plans/active/test-table.md"), "the moves reached the remote");
  } else {
    console.log("plan-store-check: reftable section skipped; this Git cannot create reftable repositories");
  }

  // ---- a store whose HEAD is off its branch is still the store: mid-rebase, or detached by hand
  const rebasing = repository("rebasing", { "plans/backlog/test-rebase.md": planDoc({ id: "rebase01" }) });
  const rebasingStore = storePath(rebasing);
  assert.notEqual(fx.tryGit(rebasingStore, "-c", "core.hooksPath=/dev/null", "rebase", "--exec", "false", "HEAD~1").status, 0, "the rebase stops");
  refused(run(rebasing, "save", source("test-mid.md", planDoc({ id: "midreb01" }))), "a save during a rebase", /Finish or abort/);
  assert.deepEqual(linkedWorktrees(path.join(rebasing, ".git")), [], "a rebasing store stays out of the worktree list");
  git(rebasingStore, "rebase", "--abort");
  git(rebasingStore, "checkout", "--quiet", "--detach");
  refused(run(rebasing, "save", source("test-mid.md", planDoc({ id: "midreb01" }))), "a save on a detached store", /Finish or abort/);
  assert.deepEqual(linkedWorktrees(path.join(rebasing, ".git")), [], "a detached store stays out of the worktree list");
  git(rebasingStore, "checkout", "--quiet", "repo-plans");

  // ---- a remote that refuses the push is reported with its reason, not retried as a race
  const refusing = repository("refusing");
  fs.writeFileSync(path.join(tmp, "remotes", "refusing.git", "hooks", "pre-receive"), "#!/bin/sh\necho 'plans branch is protected' >&2\nexit 1\n", { mode: 0o755 });
  const declined = ok(run(refusing, "save", source("test-declined.md", planDoc({ id: "declin01" }))), "a save the remote refuses");
  assert.equal(declined.synchronized, false);
  assert.match(declined.reason, /remote rejected/, "the reason is Git's refusal");

  // ---- init recreates a remote branch that was deleted, from this clone's copy
  const lost = repository("lost", { "plans/backlog/test-lost.md": planDoc({ id: "lost0001" }) });
  git(path.join(tmp, "remotes", "lost.git"), "update-ref", "-d", "refs/heads/repo-plans");
  assert.equal(initStore(lost).state, "created");
  assert.ok(remoteHas(lost, "plans/backlog/test-lost.md"), "the remote has the branch and its plans again");

  // ---- the portal's copy of a store error names no absolute path
  for (const code of ["PLAN_STORE_DIVERGED", "PLAN_STORE_DIRTY"]) {
    const sent = withoutStorePath(domainError(code, "Refused.", { resolution: `Resolve it with Git in ${rebasingStore}.` }));
    assert.doesNotMatch(sent.resolution, /\//, `${code} reaches the browser without a path`);
    assert.match(sent.resolution, /roborepo plans init/);
  }

  // ---- a replayed offline order change keeps its unpins and pins over the remote's
  const pins = (base, remote, pending) => mergeOrder({ pinned: base, namespaces: {} }, { pinned: remote, namespaces: {} }, { pinned: pending, namespaces: {} }).pinned ?? [];
  assert.deepEqual(pins(["api"], ["api", "web"], []), ["web"], "an offline unpin survives a remote pin");
  assert.deepEqual(pins(["api"], ["web"], ["api", "cli"]), ["web", "cli"], "the remote's unpin and the pending pin both stand");

  // ---- the portal fetches at startup, so a plan pushed from another machine appears without a Refresh
  const portalRepo = repository("portal-start", { "plans/backlog/test-here.md": planDoc({ id: "here0001" }) });
  const portalMachine = clone(portalRepo, "portal-start-b");
  git(portalMachine, "checkout", "--quiet", "-b", "repo-plans", "origin/repo-plans");
  fx.commit(portalMachine, "A plan from elsewhere", { "plans/backlog/test-elsewhere.md": planDoc({ id: "else0001" }) });
  git(portalMachine, "push", "--quiet", "origin", "repo-plans");
  const portalStore = storePath(portalRepo);
  assert.equal(fs.existsSync(path.join(portalStore, "plans/backlog/test-elsewhere.md")), false);
  const portalState = path.join(tmp, "portal-state");
  addRepositorySource({ path: portalRepo, stateRoot: portalState });
  const portal = await startHermeticPortal({ env: { ...fx.env, ROBOREPO_STATE_ROOT: portalState }, readyFile: path.join(tmp, "portal.ready") });
  try {
    const deadline = Date.now() + 30_000;
    while (!fs.existsSync(path.join(portalStore, "plans/backlog/test-elsewhere.md"))) {
      assert.ok(Date.now() < deadline, "the portal's startup refresh brought in the other machine's plan");
      await delay(200);
    }
  } finally {
    await portal.stop();
  }

  console.log("plan-store-check: ok");
} finally {
  fx.cleanup();
}
