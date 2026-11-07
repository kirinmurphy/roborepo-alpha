#!/usr/bin/env node
// The deterministic plan-suite commands: `roborepo plans validate`, `roborepo plans start`,
// `roborepo plans stop-servers`, and `roborepo package status`. The other lifecycle transitions are
// covered by plan-lifecycle-transitions-check.mjs. Each runs through the real CLI entry point against a fixture Git
// repository or a hermetic HOME, so argument parsing, exit status, and output shape are covered
// along with the domain logic behind them.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlanSnapshot, parsePlanMarkdown, validateRepositoryPlans } from "../../modules/plan-suite/index.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";
import { createPlanFixture } from "./lib/plan-git-fixture.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const fx = createPlanFixture("roborepo-plan-suite-commands-");
const { tmp, env, git, json } = fx;
const home = env.HOME;
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");

function roborepo(args, { cwd = repoRoot } = {}) {
  return fx.roborepo(args, { cwd });
}

function planDoc({ id, title, nextAction = "Implement the first task.", extra = "", dependsOn = "[]" }) {
  return `---
id: ${id}
next_action: ${nextAction}
blocked_by: []
depends_on: ${dependsOn}
related: []
reviewed_commit:
worktree:
---

# ${title}

## Summary

Fixture plan.

## Goals

- [ ] Do the thing.

## Context

Fixture context.

## Proposed design

Fixture design.

## Validation

- [ ] The thing is done.
${extra}`;
}

// A repository whose code checkout is on main and whose plans store holds plans in every interesting
// state. `plans/notes.txt` names a plan path so a move has a stale link to report.
function fixtureRepository(name, extra = {}) {
  return fx.repository(name, {
    "docs/guide.md": "Code docs.\n",
    "plans/ready/test-alpha.md": planDoc({ id: "alpha001", title: "Alpha" }),
    "plans/active/test-beta.md": planDoc({ id: "beta0001", title: "Beta" }),
    "plans/completed/test-gamma.md": planDoc({ id: "gamma001", title: "Gamma", nextAction: "" }).replaceAll("- [ ]", "- [x]") + "\n## Verification\n\nFixture evidence.\n",
    "plans/backlog/test-dangling.md": planDoc({ id: "dangle01", title: "Dangling", dependsOn: "[nosuch01]" }),
    "plans/notes.txt": "See plans/ready/test-alpha.md.\n",
    ...extra,
  });
}

// ── Structural parsing ignores fenced examples ──────────────────────────────────────────────────
{
  const parsed = parsePlanMarkdown(`---
id: fence001
---

# Fenced

\`\`\`markdown
## Not tested

- [ ] Sample entry inside a fence.
\`\`\`

~~~
# Not a title
- [ ] Not a task
~~~

## Not tested

- [ ] A real entry.
- [x] A confirmed entry.

### Detail

- [ ] Nested under Not tested.

## Later

- [ ] A normal task.
`);
  assert.equal(parsed.title, "Fenced", "a heading inside a fence never becomes the title");
  assert.deepEqual(parsed.headings.map((heading) => heading.text), ["Fenced", "Not tested", "Detail", "Later"],
    "headings inside fenced blocks are not plan structure");
  assert.equal(parsed.taskCounts.total, 4, "checkboxes inside fenced blocks are not tasks");
  assert.equal(parsed.notTested.present, true);
  assert.equal(parsed.notTested.unchecked, 2, "Not tested runs to the next heading of the same depth");

  const discussed = parsePlanMarkdown("---\nid: prose001\n---\n\n# Prose\n\n### `## Not tested`\n\n- [ ] Describes the section.\n");
  assert.equal(discussed.notTested.present, false, "only a literal `## Not tested` heading opens the section");
}

// ── roborepo plans validate ─────────────────────────────────────────────────────────────────────
{
  const root = fixtureRepository("validate-repo", {
    "plans/active/test-untested.md": planDoc({
      id: "untest01",
      title: "Untested",
      extra: "\n## Not tested\n\n- [ ] The live session prints a tally. No test can read agent output.\n- [x] Confirmed by hand.\n",
    }),
  });
  const store = fx.storePath(root);

  const all = roborepo(["plans", "validate", "--json"], { cwd: path.join(root, "docs") });
  const report = json(all, "validate all");
  assert.equal(report.plans.length, 5, "omitting <plan> validates every plan in the repo, from any directory of a checkout");
  const byPath = new Map(report.plans.map((plan) => [plan.relativePath, plan]));
  assert.ok(byPath.get("plans/backlog/test-dangling.md").findings.some((item) => item.code === "DEPENDENCY_NOT_FOUND"),
    "cross-plan relationship findings are included");
  const untested = byPath.get("plans/active/test-untested.md").findings.find((item) => item.code === "UNCONFIRMED_NOT_TESTED");
  assert.equal(untested?.count, 1, "an active plan reports its unchecked Not tested entries");
  assert.ok(untested.resolution && untested.severity && untested.kind, "findings keep the findings.mjs shape");
  assert.equal(all.status, 0, "advisory findings alone do not fail validation");

  const byId = json(roborepo(["plans", "validate", "beta0001", "--json"], { cwd: root }), "validate by id");
  assert.deepEqual(byId.plans.map((plan) => plan.relativePath), ["plans/active/test-beta.md"], "a plan id selects one plan");

  const relative = json(roborepo(["plans", "validate", "active/test-beta.md", "--json"], { cwd: path.join(store, "plans") }), "validate by cwd-relative path");
  assert.equal(relative.plans[0].id, "beta0001", "a path relative to the current directory selects the plan");

  const text = roborepo(["plans", "validate", "plans/backlog/test-dangling.md"], { cwd: root });
  assert.match(text.stdout, /DEPENDENCY_NOT_FOUND/, "text output names each finding code");
  assert.match(text.stdout, /1 plan checked/, "text output ends with a summary line");

  const missing = roborepo(["plans", "validate", "nosuch01"], { cwd: root });
  assert.equal(missing.status, 1, "an unresolvable plan exits 1");
  assert.match(missing.stderr, /No plan matches nosuch01/);

  fs.writeFileSync(path.join(store, "plans/backlog/test-noid.md"), "---\n---\n\n# No id\n");
  const blocking = roborepo(["plans", "validate", "plans/backlog/test-noid.md"], { cwd: root });
  assert.equal(blocking.status, 1, "a blocking finding (missing id) exits 1");

  // The CLI and the portal must agree: the portal's snapshot over discovery roots and the
  // repository-scoped validator report the same findings for the same documents.
  const stateRoot = path.join(tmp, "portal-state");
  addRepositorySource({ path: root, stateRoot });
  const portal = buildPlanSnapshot({ stateRoot });
  const cliView = validateRepositoryPlans({ cwd: root });
  const codes = (findings) => findings.map((item) => item.code).sort();
  for (const plan of cliView.plans) {
    const portalPlan = portal.plans.find((record) => record.plan.relativePath === plan.relativePath);
    assert.ok(portalPlan, `${plan.relativePath} is in the portal snapshot`);
    assert.deepEqual(codes(plan.findings), codes(portalPlan.plan.validation.findings), `${plan.relativePath}: CLI and portal findings match`);
  }
  // Rescanning must not stack relationship findings onto cached records.
  const rescanned = buildPlanSnapshot({ stateRoot }).plans.find((record) => record.plan.relativePath === "plans/backlog/test-dangling.md");
  assert.equal(rescanned.plan.validation.findings.filter((item) => item.code === "DEPENDENCY_NOT_FOUND").length, 1,
    "a rescan reports each relationship finding once");
}

// ── roborepo plans start ────────────────────────────────────────────────────────────────────────
{
  const root = fixtureRepository("start-repo");
  const store = fx.storePath(root);
  const fresh = fx.worktree(root, "feat/fresh");
  const reused = fx.worktree(root, "feat/reused");
  fx.commit(reused.path, "own work", { "work.txt": "in progress\n" });
  const freshName = fresh.name;
  const reusedName = reused.name;
  const codeHeads = () => [git(root, "rev-parse", "main"), git(fresh.path, "rev-parse", "HEAD"), git(reused.path, "rev-parse", "HEAD")];
  const codeBefore = codeHeads();

  // Unrelated work in the code checkout, staged or not, never blocks a transition or rides along.
  fs.writeFileSync(path.join(root, "scratch.txt"), "someone else's edit\n");
  fs.writeFileSync(path.join(root, "staged.txt"), "someone else's staged file\n");
  git(root, "add", "--", "staged.txt");

  // A ready plan moves to active, records the worktree, and commits only the rename on the plans branch.
  const before = git(store, "rev-parse", "HEAD");
  const started = roborepo(["plans", "start", "alpha001", "--worktree", freshName, "--json"], { cwd: root });
  const result = json(started, "start ready plan");
  assert.equal(started.status, 0, `start approves\n${started.stdout}`);
  assert.equal(result.verdict, "APPROVED");
  assert.equal(result.transition, "start");
  assert.equal(result.synchronized, true);
  assert.equal(result.plan.path, "plans/active/test-alpha.md");
  assert.deepEqual(result.plan.lifecycle, { from: "ready", to: "active" });
  assert.ok(fs.existsSync(path.join(store, "plans/active/test-alpha.md")));
  assert.ok(!fs.existsSync(path.join(store, "plans/ready/test-alpha.md")));
  assert.equal(git(store, "rev-parse", "HEAD^"), before, "exactly one transition commit");
  assert.deepEqual(git(store, "show", "--name-status", "--no-renames", "--format=", "HEAD").split("\n").map((line) => line.split("\t").join(" ")).sort(),
    ["A plans/active/test-alpha.md", "D plans/ready/test-alpha.md"], "the commit is the plan's move alone");
  assert.deepEqual(codeHeads(), codeBefore, "a transition commits nothing on any code branch");
  assert.equal(git(root, "diff", "--cached", "--name-only"), "staged.txt", "unrelated staged work stays staged");
  assert.ok(fs.existsSync(path.join(root, "scratch.txt")), "unrelated unstaged work stays in place");
  git(root, "rm", "--quiet", "--cached", "--", "staged.txt");
  fs.rmSync(path.join(root, "staged.txt"));
  fs.rmSync(path.join(root, "scratch.txt"));
  assert.match(git(store, "show", "HEAD:plans/active/test-alpha.md"), new RegExp(`^worktree: ${freshName}$`, "m"));
  assert.deepEqual(result.staleLinks, ["plans/notes.txt"], "files naming the old path are reported, not edited");
  assert.equal(result.checks.length, 6);
  assert.ok(result.checks.every((check) => check.ok));

  // Running it again finds the association already recorded and commits nothing.
  const head = git(store, "rev-parse", "HEAD");
  const again = json(roborepo(["plans", "start", "plans/active/test-alpha.md", "--worktree", freshName, "--json"], { cwd: root }), "rerun");
  assert.equal(again.verdict, "APPROVED");
  assert.equal(again.alreadyRecorded, true);
  assert.equal(git(store, "rev-parse", "HEAD"), head, "a rerun makes no commit");

  // From a linked worktree the same lifecycle command works and finds the record already there.
  const fromWorktree = json(roborepo(["plans", "start", "alpha001", "--worktree", freshName, "--json"], { cwd: fresh.path }), "start from a linked worktree");
  assert.equal(fromWorktree.verdict, "APPROVED");
  assert.equal(fromWorktree.alreadyRecorded, true);

  // An already-active plan is edited in place; a worktree with its own commits is left alone.
  const active = json(roborepo(["plans", "start", "beta0001", "--worktree", reusedName, "--json"], { cwd: root }), "start active plan");
  assert.equal(active.verdict, "APPROVED");
  assert.equal(git(store, "show", "--name-status", "--format=", "HEAD"), "M\tplans/active/test-beta.md");
  assert.deepEqual(codeHeads(), codeBefore, "the worktree branches are untouched");

  // Refusals leave the plans branch untouched.
  const refusedHead = git(store, "rev-parse", "HEAD");
  const backlog = roborepo(["plans", "start", "dangle01", "--worktree", freshName], { cwd: root });
  assert.equal(backlog.status, 1, "a backlog plan must be promoted before it can start");
  assert.match(backlog.stderr, /from ready to active; this one is backlog/);
  assert.match(backlog.stderr, /promote \(\/plan-promote\)/, "the refusal names the transition the plan can take");
  assert.ok(fs.existsSync(path.join(store, "plans/backlog/test-dangling.md")), "a refusal moves nothing");

  fs.appendFileSync(path.join(store, "plans/active/test-alpha.md"), "\nAn edit someone else is making.\n");
  const dirtyPlan = roborepo(["plans", "start", "alpha001", "--worktree", reusedName], { cwd: root });
  assert.equal(dirtyPlan.status, 1, "an uncommitted edit to the plan itself refuses");
  assert.match(dirtyPlan.stderr, /uncommitted/);
  git(store, "checkout", "--", "plans/active/test-alpha.md");

  const unknown = roborepo(["plans", "start", "alpha001", "--worktree", "nope"], { cwd: root });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No linked worktree is named nope/);

  const reserved = roborepo(["plans", "start", "alpha001", "--worktree", "repo_plans"], { cwd: root });
  assert.equal(reserved.status, 1, "the reserved plans worktree never implements a plan");
  assert.match(reserved.stderr, /reserved/);

  const completed = roborepo(["plans", "start", "gamma001", "--worktree", freshName], { cwd: root });
  assert.equal(completed.status, 1, "a completed plan cannot be started");
  assert.match(completed.stderr, /A completed plan has no further transitions/);

  assert.equal(git(store, "rev-parse", "HEAD"), refusedHead, "no refusal committed anything");
  assert.equal(roborepo(["plans", "start", "alpha001"], { cwd: root }).status, 2, "--worktree is required");
}

// ── roborepo plans stop-servers ─────────────────────────────────────────────────────────────────
{
  const root = fixtureRepository("stop-repo");
  const store = fx.storePath(root);
  const linked = fx.worktree(root, "feat/stop").path;
  const nested = path.join(root, ".claude", "worktrees", "nested");
  git(root, "worktree", "add", "--quiet", "-b", "feat/nested", nested, "main");
  const linkedName = path.basename(git(linked, "rev-parse", "--absolute-git-dir"));
  const withWorktree = (doc, name) => doc.replace(/^worktree:$/m, `worktree: ${name}`);
  fs.writeFileSync(path.join(store, "plans/active/test-served.md"), withWorktree(planDoc({ id: "serve001", title: "Served" }), linkedName));
  fs.writeFileSync(path.join(store, "plans/active/test-removed.md"), withWorktree(planDoc({ id: "remove01", title: "Removed" }), "long-gone"));

  const none = roborepo(["plans", "stop-servers", "beta0001", "--json"], { cwd: root });
  assert.equal(none.status, 0);
  assert.equal(json(none, "no worktree").worktree, null, "a plan without a worktree resolves to nothing");
  assert.deepEqual(json(none, "no worktree").servers, [], "and never falls back to the primary checkout");

  const removed = json(roborepo(["plans", "stop-servers", "remove01", "--json"], { cwd: root }), "removed worktree");
  assert.match(removed.reason, /No linked worktree is named long-gone/);
  assert.deepEqual(removed.servers, []);

  assert.equal(roborepo(["plans", "stop-servers"], { cwd: root }).status, 2, "<plan> is required");

  if (process.platform === "darwin") {
    // Real listeners: two in the linked worktree (its root and a subdirectory), one in the primary
    // checkout, and one in a worktree nested inside the primary's directory tree.
    const listen = (cwd) => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, ["-e",
        "require('node:http').createServer(() => {}).listen(0, '127.0.0.1', function () { console.log(this.address().port); });"],
      { cwd, stdio: ["ignore", "pipe", "inherit"] });
      child.exited = new Promise((done) => child.once("exit", (code, signal) => done(signal || code)));
      child.stdout.once("data", () => resolve(child));
      child.once("error", reject);
    });
    const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
    fs.mkdirSync(path.join(linked, "apps", "web"), { recursive: true });
    const [inRoot, inSub, inPrimary, inNested] = await Promise.all([linked, path.join(linked, "apps", "web"), root, nested].map(listen));
    try {
      const own = [inRoot.pid, inSub.pid].sort((a, b) => a - b);
      const dry = json(roborepo(["plans", "stop-servers", "serve001", "--dry-run", "--json"], { cwd: root }), "dry run");
      assert.equal(dry.worktree.path, fs.realpathSync(linked));
      assert.deepEqual(dry.servers.map((server) => server.pid), own, "the worktree's root and subdirectory listeners are selected");
      assert.ok(dry.servers.every((server) => server.result === "would-stop" && server.ports.length === 1));
      assert.ok([inRoot, inSub, inPrimary, inNested].every((child) => alive(child.pid)), "a dry run stops nothing");

      const stopped = roborepo(["plans", "stop-servers", "serve001", "--json"], { cwd: root });
      assert.equal(stopped.status, 0, stopped.stdout);
      assert.deepEqual(json(stopped, "stop").servers.map((server) => [server.pid, server.result]), own.map((pid) => [pid, "stopped"]));
      assert.equal(await inRoot.exited, "SIGTERM");
      assert.equal(await inSub.exited, "SIGTERM");
      assert.ok(alive(inPrimary.pid), "the primary checkout's listener keeps running");
      assert.ok(alive(inNested.pid), "a worktree nested inside the primary is a different checkout");

      const text = roborepo(["plans", "stop-servers", "serve001"], { cwd: root });
      assert.match(text.stdout, /no servers running in the worktree/, "a second run finds nothing");
    } finally {
      for (const child of [inRoot, inSub, inPrimary, inNested]) if (alive(child.pid)) child.kill("SIGKILL");
    }
  } else {
    const unsupported = roborepo(["plans", "stop-servers", "serve001", "--json"], { cwd: root });
    assert.equal(unsupported.status, 0, "an unsupported platform is not a failure");
    assert.equal(json(unsupported, "unsupported").supported, false);
  }
}

// ── roborepo package status ─────────────────────────────────────────────────────────────────────
{
  const status = (id) => {
    const result = roborepo(["package", "status", id, "--json"]);
    return { ...json(result, `package status ${id}`), exit: result.status };
  };

  assert.deepEqual(status("plan-suite"), { id: "plan-suite", available: true, enabled: false, status: "disabled", exit: 0 });

  assert.equal(roborepo(["package", "enable", "plan-suite"]).status, 0);
  assert.deepEqual(status("plan-suite"), { id: "plan-suite", available: true, enabled: true, status: "enabled", exit: 0 });

  // Desired but incomplete on disk: one skill's command wrapper was removed behind the registry's
  // back, and the other five skills being whole does not make the package whole.
  fs.rmSync(path.join(home, ".claude", "commands", "plan-write.md"), { force: true });
  assert.equal(status("plan-suite").status, "partial", "an enabled package missing a component is partial");

  roborepo(["package", "enable", "telemetry"]);
  fs.writeFileSync(path.join(home, ".roborepo", "telemetry", "state.json"), '{"enabled":false,"updatedAt":"x"}\n');
  assert.deepEqual(status("telemetry"), { id: "telemetry", available: true, enabled: true, status: "configured", exit: 0 },
    "an enabled package whose service is off is configured");

  const installed = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify(path.join(repoRoot, "scripts/cli/config-mutate.mjs"))}).then((m) => process.exit(m.setSkillInstalled("case-study", true).ok ? 0 : 1))`,
  ], { env, cwd: repoRoot });
  assert.equal(installed.status, 0, "fixture: install a skill outside the package registry");
  assert.deepEqual(status("case-study-pack"), { id: "case-study-pack", available: true, enabled: false, status: "external", exit: 0 },
    "a skill installed outside the registry reads as external");

  const unavailable = spawnSync(process.execPath, ["-e",
    `import(${JSON.stringify(path.join(repoRoot, "scripts/cli/package-status.mjs"))}).then((m) => console.log(JSON.stringify(m.packageStatusSummary("pending-pkg", { catalog: [{ id: "pending-pkg", status: "pending" }] }))))`,
  ], { env, cwd: repoRoot, encoding: "utf8" });
  assert.deepEqual(JSON.parse(unavailable.stdout), { id: "pending-pkg", available: false, enabled: false, status: "unavailable" });

  const missing = roborepo(["package", "status", "no-such-package", "--json"]);
  assert.equal(missing.status, 1, "an unknown package id exits 1");
  assert.equal(json(missing, "missing").status, "missing");

  assert.match(roborepo(["package", "status", "plan-suite"]).stdout, /^plan-suite: partial$/m, "text output is one line");
}

fx.cleanup();
console.log("plan-suite commands: ok");
