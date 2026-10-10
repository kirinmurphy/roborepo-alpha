#!/usr/bin/env node
// The deterministic plan-suite commands: `roborepo plans validate`, `roborepo plans start`,
// `roborepo plans stop-servers`, and `roborepo package status`. Each runs through the real CLI entry point against a fixture Git
// repository or a hermetic HOME, so argument parsing, exit status, and output shape are covered
// along with the domain logic behind them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { buildPlanSnapshot, parsePlanMarkdown, validateRepositoryPlans } from "../../modules/plan-suite/index.mjs";
import { addRepositorySource } from "../cli/repository-sources.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const cli = path.join(repoRoot, "scripts/cli/main.mjs");
const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-plan-suite-commands-")));
const home = path.join(tmp, "home");
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");

const env = {
  ...process.env,
  HOME: home,
  ROBOREPO_STATE_DIR: path.join(home, ".roborepo"),
  ROBOREPO_STATE_ROOT: path.join(home, ".roborepo"),
  SKIP_MCP: "1",
  ROBOREPO_PRESETS_ONBOARD: "skip",
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "Fixture",
  GIT_AUTHOR_EMAIL: "fixture@example.invalid",
  GIT_COMMITTER_NAME: "Fixture",
  GIT_COMMITTER_EMAIL: "fixture@example.invalid",
};
for (const key of ["ROBOREPO_WORKSPACE_ROOT", "ROBOREPO_APP_ROOT", "GIT_DIR", "GIT_WORK_TREE"]) delete env[key];
// The in-process validateRepositoryPlans/buildPlanSnapshot calls shell out to git too.
Object.assign(process.env, { GIT_CONFIG_NOSYSTEM: "1", HOME: home });

function roborepo(args, { cwd = repoRoot } = {}) {
  return spawnSync(process.execPath, [cli, ...args], { cwd, env, encoding: "utf8" });
}

function git(cwd, ...args) {
  const result = spawnSync("git", ["-C", cwd, ...args], { env, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")} failed: ${result.stderr}`);
  return result.stdout.trim();
}

function json(result, label) {
  try {
    return JSON.parse(result.stdout);
  } catch {
    assert.fail(`${label}: expected JSON\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

function planDoc({ id, title, nextAction = "Implement the first task.", extra = "", dependsOn = "[]" }) {
  return `---
id: ${id}
priority: medium
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

// A repository with a primary checkout on main and plans in every interesting state.
function fixtureRepository(name) {
  const root = path.join(tmp, name);
  for (const lifecycle of ["backlog", "active", "completed"]) fs.mkdirSync(path.join(root, "docs", "plans", lifecycle), { recursive: true });
  fs.writeFileSync(path.join(root, "docs/plans/backlog/test-alpha.md"), planDoc({ id: "alpha001", title: "Alpha" }));
  fs.writeFileSync(path.join(root, "docs/plans/active/test-beta.md"), planDoc({ id: "beta0001", title: "Beta" }));
  fs.writeFileSync(path.join(root, "docs/plans/completed/test-gamma.md"), planDoc({ id: "gamma001", title: "Gamma", nextAction: "" }).replaceAll("- [ ]", "- [x]") + "\n## Verification\n\nFixture evidence.\n");
  fs.writeFileSync(path.join(root, "docs/plans/backlog/test-dangling.md"), planDoc({ id: "dangle01", title: "Dangling", dependsOn: "[nosuch01]" }));
  fs.writeFileSync(path.join(root, "README.md"), "See docs/plans/backlog/test-alpha.md.\n");
  git(tmp, "init", "--quiet", "--initial-branch=main", root);
  git(root, "add", "--", ".");
  git(root, "commit", "--quiet", "-m", "fixture");
  return root;
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
  const root = fixtureRepository("validate-repo");
  fs.writeFileSync(path.join(root, "docs/plans/active/test-untested.md"), planDoc({
    id: "untest01",
    title: "Untested",
    extra: "\n## Not tested\n\n- [ ] The live session prints a tally. No test can read agent output.\n- [x] Confirmed by hand.\n",
  }));
  git(root, "add", "--", "docs/plans/active/test-untested.md");
  git(root, "commit", "--quiet", "-m", "untested plan");

  const all = roborepo(["plans", "validate", "--json"], { cwd: path.join(root, "docs") });
  const report = json(all, "validate all");
  assert.equal(report.plans.length, 5, "omitting <plan> validates every plan in the current repository");
  const byPath = new Map(report.plans.map((plan) => [plan.relativePath, plan]));
  assert.ok(byPath.get("docs/plans/backlog/test-dangling.md").findings.some((item) => item.code === "DEPENDENCY_NOT_FOUND"),
    "cross-plan relationship findings are included");
  const untested = byPath.get("docs/plans/active/test-untested.md").findings.find((item) => item.code === "UNCONFIRMED_NOT_TESTED");
  assert.equal(untested?.count, 1, "an active plan reports its unchecked Not tested entries");
  assert.ok(untested.resolution && untested.severity && untested.kind, "findings keep the findings.mjs shape");
  assert.equal(all.status, 0, "advisory findings alone do not fail validation");

  const byId = json(roborepo(["plans", "validate", "beta0001", "--json"], { cwd: root }), "validate by id");
  assert.deepEqual(byId.plans.map((plan) => plan.relativePath), ["docs/plans/active/test-beta.md"], "a plan id selects one plan");

  const relative = json(roborepo(["plans", "validate", "active/test-beta.md", "--json"], { cwd: path.join(root, "docs", "plans") }), "validate by cwd-relative path");
  assert.equal(relative.plans[0].id, "beta0001", "a path relative to the current directory selects the plan");

  const text = roborepo(["plans", "validate", "docs/plans/backlog/test-dangling.md"], { cwd: root });
  assert.match(text.stdout, /DEPENDENCY_NOT_FOUND/, "text output names each finding code");
  assert.match(text.stdout, /1 plan checked/, "text output ends with a summary line");

  const missing = roborepo(["plans", "validate", "nosuch01"], { cwd: root });
  assert.equal(missing.status, 1, "an unresolvable plan exits 1");
  assert.match(missing.stderr, /No plan matches nosuch01/);

  fs.writeFileSync(path.join(root, "docs/plans/backlog/test-noid.md"), "---\npriority: low\n---\n\n# No id\n");
  const blocking = roborepo(["plans", "validate", "docs/plans/backlog/test-noid.md"], { cwd: root });
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
  const rescanned = buildPlanSnapshot({ stateRoot }).plans.find((record) => record.plan.relativePath === "docs/plans/backlog/test-dangling.md");
  assert.equal(rescanned.plan.validation.findings.filter((item) => item.code === "DEPENDENCY_NOT_FOUND").length, 1,
    "a rescan reports each relationship finding once");
}

// ── roborepo plans start ────────────────────────────────────────────────────────────────────────
{
  const root = fixtureRepository("start-repo");
  const fresh = path.join(tmp, "worktrees", "fresh");
  const reused = path.join(tmp, "worktrees", "reused");
  git(root, "worktree", "add", "--quiet", "-b", "feat/fresh", fresh, "main");
  git(root, "worktree", "add", "--quiet", "-b", "feat/reused", reused, "main");
  fs.writeFileSync(path.join(reused, "work.txt"), "in progress\n");
  git(reused, "add", "--", "work.txt");
  git(reused, "commit", "--quiet", "-m", "own work");
  const freshName = path.basename(git(fresh, "rev-parse", "--absolute-git-dir"));
  const reusedName = path.basename(git(reused, "rev-parse", "--absolute-git-dir"));

  // A backlog plan moves to active, records the worktree, and commits only the rename.
  const before = git(root, "rev-parse", "HEAD");
  const started = roborepo(["plans", "start", "alpha001", "--worktree", freshName, "--json"], { cwd: root });
  const result = json(started, "start backlog plan");
  assert.equal(started.status, 0, `start approves\n${started.stdout}`);
  assert.equal(result.verdict, "APPROVED");
  assert.equal(result.plan.path, "docs/plans/active/test-alpha.md");
  assert.ok(fs.existsSync(path.join(root, "docs/plans/active/test-alpha.md")));
  assert.ok(!fs.existsSync(path.join(root, "docs/plans/backlog/test-alpha.md")));
  assert.equal(git(root, "rev-parse", "HEAD^"), before, "exactly one transition commit");
  assert.deepEqual(git(root, "show", "--name-status", "--format=", "HEAD").split("\t").slice(1),
    ["docs/plans/backlog/test-alpha.md", "docs/plans/active/test-alpha.md"], "the commit is the plan's rename alone");
  assert.match(git(root, "show", "HEAD:docs/plans/active/test-alpha.md"), new RegExp(`^worktree: ${freshName}$`, "m"));
  assert.equal(result.fastForward.applied, true, "a worktree with no commits of its own is fast-forwarded");
  assert.equal(git(fresh, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD"));
  assert.deepEqual(result.staleLinks, ["README.md"], "files naming the old path are reported, not edited");
  assert.equal(result.checks.length, 6);
  assert.ok(result.checks.every((check) => check.ok));

  // Running it again finds the association already recorded and commits nothing.
  const head = git(root, "rev-parse", "HEAD");
  const again = json(roborepo(["plans", "start", "docs/plans/active/test-alpha.md", "--worktree", freshName, "--json"], { cwd: root }), "rerun");
  assert.equal(again.verdict, "APPROVED");
  assert.equal(again.alreadyRecorded, true);
  assert.equal(git(root, "rev-parse", "HEAD"), head, "a rerun makes no commit");

  // An already-active plan is edited in place; a worktree with its own commits is left alone.
  const active = json(roborepo(["plans", "start", "beta0001", "--worktree", reusedName, "--json"], { cwd: root }), "start active plan");
  assert.equal(active.verdict, "APPROVED");
  assert.equal(git(root, "show", "--name-status", "--format=", "HEAD"), "M\tdocs/plans/active/test-beta.md");
  assert.equal(active.fastForward.applied, false);
  assert.match(active.fastForward.reason, /own commits/);
  assert.notEqual(git(reused, "rev-parse", "HEAD"), git(root, "rev-parse", "HEAD"), "the reused branch is untouched");

  // Refusals leave the base branch untouched.
  const refusedHead = git(root, "rev-parse", "HEAD");
  fs.writeFileSync(path.join(root, "scratch.txt"), "someone else's edit\n");
  const dirty = roborepo(["plans", "start", "dangle01", "--worktree", freshName], { cwd: root });
  assert.equal(dirty.status, 1, "a dirty primary checkout refuses");
  assert.match(dirty.stderr, /uncommitted changes/);
  assert.ok(fs.existsSync(path.join(root, "docs/plans/backlog/test-dangling.md")), "a refusal moves nothing");
  fs.rmSync(path.join(root, "scratch.txt"));

  const fromWorktree = roborepo(["plans", "start", "dangle01", "--worktree", freshName], { cwd: fresh });
  assert.equal(fromWorktree.status, 1, "running from the linked worktree refuses");
  assert.match(fromWorktree.stderr, /primary checkout/);

  const unknown = roborepo(["plans", "start", "dangle01", "--worktree", "nope"], { cwd: root });
  assert.equal(unknown.status, 1);
  assert.match(unknown.stderr, /No linked worktree is named nope/);

  const completed = roborepo(["plans", "start", "gamma001", "--worktree", freshName], { cwd: root });
  assert.equal(completed.status, 1, "a completed plan cannot be started");
  assert.match(completed.stderr, /backlog or active/);

  assert.equal(git(root, "rev-parse", "HEAD"), refusedHead, "no refusal committed anything");
  assert.equal(roborepo(["plans", "start", "alpha001"], { cwd: root }).status, 2, "--worktree is required");
}

// ── roborepo plans stop-servers ─────────────────────────────────────────────────────────────────
{
  const root = fixtureRepository("stop-repo");
  const linked = path.join(tmp, "worktrees", "stop-linked");
  const nested = path.join(root, ".claude", "worktrees", "nested");
  git(root, "worktree", "add", "--quiet", "-b", "feat/stop", linked, "main");
  git(root, "worktree", "add", "--quiet", "-b", "feat/nested", nested, "main");
  const linkedName = path.basename(git(linked, "rev-parse", "--absolute-git-dir"));
  const withWorktree = (doc, name) => doc.replace(/^worktree:$/m, `worktree: ${name}`);
  fs.writeFileSync(path.join(root, "docs/plans/active/test-served.md"), withWorktree(planDoc({ id: "serve001", title: "Served" }), linkedName));
  fs.writeFileSync(path.join(root, "docs/plans/active/test-removed.md"), withWorktree(planDoc({ id: "remove01", title: "Removed" }), "long-gone"));

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

  assert.deepEqual(status("plan-write"), { id: "plan-write", available: true, enabled: false, status: "disabled", exit: 0 });

  assert.equal(roborepo(["package", "enable", "plan-write"]).status, 0);
  assert.deepEqual(status("plan-write"), { id: "plan-write", available: true, enabled: true, status: "enabled", exit: 0 });

  // Desired but incomplete on disk: the command wrapper was removed behind the registry's back.
  fs.rmSync(path.join(home, ".claude", "commands", "plan-write.md"), { force: true });
  assert.equal(status("plan-write").status, "partial", "an enabled package missing a component is partial");

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

  assert.match(roborepo(["package", "status", "plan-write"]).stdout, /^plan-write: partial$/m, "text output is one line");
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log("plan-suite commands: ok");
