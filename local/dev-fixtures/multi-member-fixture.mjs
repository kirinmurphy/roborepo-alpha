// Live fixture for the Runtime page's checkout rows when members are plain processes, not Docker.
//
// WHY THIS EXISTS: the row layout behaves differently by what a checkout runs (see
// docs/plans/completed/developer-runtime-repository-row-layout.md), and a normal machine rarely shows
// the interesting cases at once. A dev server that holds several ports is one process — Runtime
// folds those into a single member — so "several members" needs several processes, and a worktree
// running only an API, or an app answering 503, is not something anyone keeps running on purpose.
//
// THE SHAPE: one repository, the main checkout plus six linked worktrees, each running Node HTTP
// servers from inside its own directory so Runtime resolves them to that checkout (Runtime lists a
// worktree only while something runs in it). Each checkout carries one row state:
//
//   checkout      branch                     servers                        row state
//   main          feature/checkout-redesign  app, API, "Storybook" page     13d behind main (2 commits); one copy action
//   -wt-failing   failing-checkout           titled app answering 503       1 behind remote (danger)
//   -wt-api       api-checkout               JSON API; an uncommitted file  6d+ since main
//   -wt-main      main                       titled app                     6d unpushed; one copy action
//   -wt-docs      docs-refresh               titled app                     8d+ behind main (1 commit)
//   -wt-detached  (detached at c2)           JSON API                       no warning; copy commit SHA
//   -wt-local     local-experiment           titled app                     no warning: never pushed
//
// The main checkout is on a feature branch so its row has a single copy action (branch name only);
// main itself lives in a worktree, whose only copy action is its path. That is also the one place
// "unpushed" can show: on any other branch the base-drift rule outranks it, and this history keeps
// main still for over 4 days so "since main" can show too. Detached and never-pushed checkouts have
// no upstream, so drift is never measured for them and their rows stay quiet. The servers exercise
// the member layouts: a promoted app over tooling and an API behind a caret, a lone failing app
// folded into its row with a health badge, and API-only checkouts with no promoted link.
//
// THE HISTORY is rebuilt on every start with backdated commits and local origin/* refs — nothing is
// ever fetched, and the remote is unfetchable — so the drift ages hold whenever the fixture runs:
//
//   origin/main       c0 (20d) - c1 (13d) - c2 (8d) - c3 (6d)
//   feature           c1 - f1 (12d) - f2 (2d)         = origin, merge-base c1   -> behind main (2 commits)
//   docs-refresh      c2 - d1 (7d)                    = origin, merge-base c2   -> behind main (1 commit)
//   main              c3 - m1 (5d) - m2 (3d)          origin at c3              -> unpushed since 6d
//   api-checkout      c3 - a1 (5d)                    = origin, merge-base c3   -> since main, 6d
//   failing           c3 - x1 (5d)                    origin one ahead (x2, 1d) -> behind remote
//   local-experiment  c3 - l1 (4d)                    no origin, no upstream    -> nothing
//   (detached)        HEAD at c2                      no branch                 -> nothing
//
// FETCH_HEAD is dated 10 days ago: older than the 6d and 8d gaps (so those read "6d+" and "8d+") and
// newer than the 13d one. Start rewrites these refs and resets the fixture checkouts to them; they
// are generated state, like everything else under the fixture directory.
//
// The "checkout missing" row is not here: Runtime only shows it for a repository with nothing
// running, so it lives in idle-checkout-fixture.mjs.
//
// No Docker: the servers are `node` processes started detached, their PIDs recorded in a state file
// beside the fixture so `stop` kills exactly what `start` launched and nothing else.
//
// Driven by developer-runtime-test-data.mjs, which runs this alongside the shared Compose fixture.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const PARENT = path.join(os.homedir(), "projects", "prototypin");
const FIXTURE_ROOT = path.join(PARENT, "multi-member-fixture");
const STATE_FILE = path.join(PARENT, ".multi-member-fixture.json");
const REMOTE = "https://github.com/example/multi-member-fixture.git";

// Loopback and high, beside the Compose fixture's 48080, so nothing here can contend with a real
// service or be reachable off the machine.
// `detach` names a commit from buildHistory to check out with no branch.
const CHECKOUTS = [
  { dir: FIXTURE_ROOT, branch: "feature/checkout-redesign", worktree: false, servers: [["app", 48101], ["api", 48102], ["tooling", 48103]] },
  { dir: `${FIXTURE_ROOT}-wt-failing`, branch: "failing-checkout", worktree: true, servers: [["failing", 48104]] },
  { dir: `${FIXTURE_ROOT}-wt-api`, branch: "api-checkout", worktree: true, servers: [["api", 48105]] },
  { dir: `${FIXTURE_ROOT}-wt-main`, branch: "main", worktree: true, servers: [["app", 48106]] },
  { dir: `${FIXTURE_ROOT}-wt-docs`, branch: "docs-refresh", worktree: true, servers: [["app", 48107]] },
  { dir: `${FIXTURE_ROOT}-wt-detached`, detach: "c2", worktree: true, servers: [["api", 48108]] },
  { dir: `${FIXTURE_ROOT}-wt-local`, branch: "local-experiment", worktree: true, servers: [["app", 48109]] },
];

const DAY_SECONDS = 24 * 60 * 60;

// Committed into the fixture repository, so every checkout runs its own copy from its own directory.
// Each role answers the way Runtime's classifier needs to see it: a <title> makes an app, the
// Storybook title makes tooling, JSON makes an API, and a 503 makes an unhealthy app.
const SERVER_SOURCE = `// Generated by roborepo's local/dev-fixtures/multi-member-fixture.mjs. Not a real server.
import http from "node:http";

const [role, port] = [process.argv[2], Number(process.argv[3])];
const page = (title) => \`<!doctype html><meta charset="utf-8"><title>\${title}</title><h1>\${title}</h1><p>Runtime test fixture. Stop it with <code>roborepo dev fixture stop</code>.</p>\`;
const RESPONSES = {
  app: [200, "text/html; charset=utf-8", page("Multi-member fixture — app")],
  tooling: [200, "text/html; charset=utf-8", page("Storybook — multi-member fixture")],
  failing: [503, "text/html; charset=utf-8", page("Multi-member fixture — failing app")],
  api: [200, "application/json", JSON.stringify({ ok: true, role: "api" })],
};
const [status, type, body] = RESPONSES[role];
http.createServer((req, res) => {
  res.writeHead(status, { "Content-Type": type });
  res.end(body);
}).listen(port, "127.0.0.1");
`;

const README = `# multi-member-fixture

Generated by \`node local/dev-fixtures/developer-runtime-test-data.mjs start\` in the roborepo dev checkout.

One repository, its main checkout on a feature branch plus six linked worktrees, each running plain
Node servers and each in a different git state (drift warnings, detached HEAD, never pushed), so
Runtime's checkout rows show those cases side by side. The history is generated with backdated commits; nothing here was ever pushed.

Not a real project. Safe to delete once stopped — the \`start\` command rebuilds it.
`;

const run = (cmd, args, cwd) => spawnSync(cmd, args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
const git = (args, cwd = FIXTURE_ROOT) => run("git", args, cwd);

// The fixture owns its set of linked worktrees. One left from an earlier layout (a renamed checkout)
// would still be on disk, still registered, and possibly holding a branch another checkout now
// needs — so any fixture worktree not in CHECKOUTS is removed. Only this fixture's own generated
// `multi-member-fixture-wt-*` directories are candidates; nothing else is touched.
function pruneStaleWorktrees() {
  const wanted = new Set(CHECKOUTS.filter((checkout) => checkout.worktree).map((checkout) => checkout.dir));
  const listed = git(["worktree", "list", "--porcelain"]).stdout
    .split("\n")
    .filter((line) => line.startsWith("worktree "))
    .map((line) => line.slice("worktree ".length));
  for (const dir of listed) {
    if (wanted.has(dir) || !path.basename(dir).startsWith("multi-member-fixture-wt-") || path.dirname(dir) !== PARENT) continue;
    git(["worktree", "remove", "--force", dir]);
  }
  git(["worktree", "prune"]);
}

function provision() {
  if (!fs.existsSync(path.join(FIXTURE_ROOT, ".git"))) {
    fs.mkdirSync(FIXTURE_ROOT, { recursive: true });
    git(["init", "-q", "."]);
    // A remote gives the fixture a stable repository identity; the example URL is deliberately
    // unfetchable so it can never be mistaken for something with a real upstream.
    git(["remote", "add", "origin", REMOTE]);
  }
  fs.writeFileSync(path.join(FIXTURE_ROOT, "README.md"), README);
  fs.writeFileSync(path.join(FIXTURE_ROOT, "server.mjs"), SERVER_SOURCE);
  git(["add", "README.md", "server.mjs"]);
  const tree = git(["write-tree"]).stdout.trim();
  const { branches, commits } = buildHistory(tree);

  for (const [branch, { local, remote }] of Object.entries(branches)) {
    git(["update-ref", `refs/heads/${branch}`, local]);
    if (!remote) {
      // Never pushed: no origin ref and no upstream, so Runtime measures no drift for it at all.
      git(["update-ref", "-d", `refs/remotes/origin/${branch}`]);
      git(["config", "--unset-all", `branch.${branch}.remote`]);
      git(["config", "--unset-all", `branch.${branch}.merge`]);
      continue;
    }
    git(["update-ref", `refs/remotes/origin/${branch}`, remote]);
    // Tracking config, so each branch has an upstream: drift is only measured for tracked branches.
    git(["config", `branch.${branch}.remote`, "origin"]);
    git(["config", `branch.${branch}.merge`, `refs/heads/${branch}`]);
  }
  // origin/HEAD names the base branch the drift warnings measure against.
  git(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);

  pruneStaleWorktrees();
  // Main checkout first: it must leave main before the -wt-main worktree can check main out.
  const [main, ...worktrees] = CHECKOUTS;
  git(["symbolic-ref", "HEAD", `refs/heads/${main.branch}`]);
  git(["reset", "-q", "--hard"]);
  for (const checkout of worktrees) {
    const target = checkout.detach ? commits[checkout.detach] : checkout.branch;
    if (!fs.existsSync(checkout.dir)) {
      git(["worktree", "add", "-q", ...(checkout.detach ? ["--detach"] : []), checkout.dir, target]);
    } else if (checkout.detach) {
      git(["checkout", "-q", "-f", "--detach", target], checkout.dir);
    } else {
      git(["symbolic-ref", "HEAD", `refs/heads/${checkout.branch}`], checkout.dir);
      git(["reset", "-q", "--hard"], checkout.dir);
    }
  }
  // An uncommitted file, so one checkout's tooltip reports a dirty working tree.
  fs.writeFileSync(path.join(`${FIXTURE_ROOT}-wt-api`, "scratch-notes.txt"), "Uncommitted work in progress.\n");
  // The last fetch, 10 days ago: older than the 6d and 8d gaps and newer than the 13d one.
  const fetchHead = path.join(FIXTURE_ROOT, ".git", "FETCH_HEAD");
  fs.writeFileSync(fetchHead, "");
  const fetchedAt = new Date(Date.now() - 10 * DAY_SECONDS * 1000);
  fs.utimesSync(fetchHead, fetchedAt, fetchedAt);
}

// Backdated commits over one tree (the fixture's content never changes between them; only the
// history's shape and ages matter). Returns each branch's local and origin tips (origin null for a
// branch that was never pushed), plus the commits a detached checkout can name.
function buildHistory(tree) {
  const now = Math.floor(Date.now() / 1000);
  const commit = (message, daysAgo, parent) => {
    const when = `${now - Math.round(daysAgo * DAY_SECONDS)} +0000`;
    const env = {
      ...process.env,
      GIT_AUTHOR_NAME: "roborepo fixture",
      GIT_AUTHOR_EMAIL: "fixture@example.com",
      GIT_AUTHOR_DATE: when,
      GIT_COMMITTER_NAME: "roborepo fixture",
      GIT_COMMITTER_EMAIL: "fixture@example.com",
      GIT_COMMITTER_DATE: when,
    };
    const args = ["commit-tree", tree, "-m", message, ...(parent ? ["-p", parent] : [])];
    return spawnSync("git", args, { cwd: FIXTURE_ROOT, env, encoding: "utf8" }).stdout.trim();
  };
  const c0 = commit("Start the fixture project", 20);
  const c1 = commit("Shared base for the feature branch", 13, c0);
  const c2 = commit("Main moves on after the feature branched", 8, c1);
  const c3 = commit("Main moves on again", 6, c2);
  const f1 = commit("Start the checkout redesign", 12, c1);
  const f2 = commit("Continue the checkout redesign", 2, f1);
  const d1 = commit("Docs refresh, pushed", 7, c2);
  const m1 = commit("Local work on main, not pushed", 5, c3);
  const m2 = commit("More local work on main, not pushed", 3, m1);
  const a1 = commit("API checkout work, pushed", 5, c3);
  const x1 = commit("Failing checkout work, pushed", 5, c3);
  const x2 = commit("Someone else pushed to failing-checkout", 1, x1);
  const l1 = commit("Local experiment, never pushed", 4, c3);
  return {
    branches: {
      main: { local: m2, remote: c3 },
      "feature/checkout-redesign": { local: f2, remote: f2 },
      "docs-refresh": { local: d1, remote: d1 },
      "api-checkout": { local: a1, remote: a1 },
      "failing-checkout": { local: x1, remote: x2 },
      "local-experiment": { local: l1, remote: null },
    },
    commits: { c2 },
  };
}

function readState() {
  try {
    return JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
  } catch {
    return { servers: [] };
  }
}

// A recorded PID is only ours if it is still a node process running this fixture's server.mjs — a
// PID reused by an unrelated process after a reboot must never be signalled.
function isFixtureProcess(pid) {
  const ps = run("ps", ["-p", String(pid), "-o", "args="]);
  return ps.status === 0 && ps.stdout.includes("multi-member-fixture") && ps.stdout.includes("server.mjs");
}

function liveServers() {
  return readState().servers.filter((server) => isFixtureProcess(server.pid));
}

export function startMultiMemberFixture() {
  if (run("git", ["--version"]).status !== 0) return { ok: false, message: "git is unavailable" };
  // Stopped first: a restart replaces the servers rather than stacking a second set on the same
  // ports, and provisioning may remove a stale worktree one of them is running in.
  stopServers();
  provision();
  const servers = [];
  for (const checkout of CHECKOUTS) {
    if (!fs.existsSync(checkout.dir)) continue;
    for (const [role, port] of checkout.servers) {
      // cwd is what makes Runtime attribute the process to this checkout: identity is resolved from
      // the listener's working directory.
      const child = spawn(process.execPath, [path.join(checkout.dir, "server.mjs"), role, String(port)], {
        cwd: checkout.dir,
        detached: true,
        stdio: "ignore",
      });
      child.on("error", (error) => console.warn(`multi-member fixture: failed to start ${role} on port ${port}: ${error.message}`));
      child.unref();
      servers.push({ pid: child.pid, role, port, checkout: path.basename(checkout.dir) });
    }
  }
  fs.writeFileSync(STATE_FILE, `${JSON.stringify({ servers }, null, 2)}\n`);
  return `multi-member fixture running on ports ${servers.map((server) => server.port).join(", ")} (${FIXTURE_ROOT} + ${CHECKOUTS.filter((checkout) => checkout.worktree).map((checkout) => path.basename(checkout.dir).replace("multi-member-fixture", "")).join(", ")})`;
}

function stopServers() {
  const live = liveServers();
  for (const server of live) {
    try { process.kill(server.pid, "SIGTERM"); } catch {}
  }
  fs.rmSync(STATE_FILE, { force: true });
  return live.length;
}

// Stops the servers and keeps the checkouts, like the Compose fixture: deleting a git working tree
// to turn a fixture off is a destructive default.
export function stopMultiMemberFixture() {
  if (!fs.existsSync(path.join(FIXTURE_ROOT, ".git"))) return "multi-member fixture: nothing provisioned";
  const stopped = stopServers();
  return `multi-member fixture: stopped ${stopped} server${stopped === 1 ? "" : "s"}; checkouts kept at ${FIXTURE_ROOT}`;
}

export function statusMultiMemberFixture() {
  if (!fs.existsSync(path.join(FIXTURE_ROOT, ".git"))) return "multi-member fixture: not provisioned";
  const live = liveServers();
  const expected = CHECKOUTS.reduce((total, checkout) => total + checkout.servers.length, 0);
  return live.length
    ? `multi-member fixture: ${live.length} of ${expected} servers running (${FIXTURE_ROOT})`
    : `multi-member fixture: provisioned but stopped (${FIXTURE_ROOT})`;
}
