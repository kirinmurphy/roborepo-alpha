#!/usr/bin/env node
// The shared repository scope against a real served portal: a seeded registry and the committed
// fixture spool, so /api/data's analysis cache, the registry, and Activity outside listed repos
// (`_other`) are exercised together. Route and resolver details are in repository-scope-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  URL_KEY_PATTERN, defaultRegistry, hideRepository, updateRegistry, upsertRepository, writeRegistry,
  registerLocalRoot, registerLocalRootPath, rootId,
} from "../../modules/repositories/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repository-scope-portal-"));
const ready = path.join(tmp, "ready");
const state = path.join(tmp, "state");
const spoolDir = path.join(state, "telemetry", "spool");

// The fixture rows are remapped onto this check's own repositories: dev fixture ids are hidden from
// every registry reader outside dev mode. Listed: SHARED and IDLE. Ignored: MULTI. UNKNOWN is in
// the spool but not the registry, and one session carries no repository.
const SHARED = "git:github.com/acme/scope-shared";
const IDLE = "git:github.com/acme/scope-idle";
const MULTI = "git:github.com/acme/scope-ignored";
const UNKNOWN = "git:github.com/acme/scope-unknown";
const FIXTURE_IDS = {
  "git:github.com/example/shared-stack-fixture": SHARED,
  "git:github.com/example/idle-checkout-fixture": IDLE,
  "git:github.com/example/multi-member-fixture": MULTI,
};
const UNKNOWN_SESSION = "demo-legacy-jun9-0011";
const NO_REPOSITORY_SESSION = "demo-spike-jun13-0014";
const HIDDEN_SESSION = "demo-legacy-jun10-0013";

const rows = fs.readFileSync(path.join(root, "local/dev-fixtures/token-warnings-spool.jsonl"), "utf8")
  .split("\n").filter(Boolean).map((line) => JSON.parse(line))
  .map((row) => ({ ...row, repo: { ...row.repo, repository_id: FIXTURE_IDS[row.repo.repository_id] } }))
  .map((row) => {
    if (row.session_id === UNKNOWN_SESSION) return { ...row, repo: { ...row.repo, repository_id: UNKNOWN } };
    if (row.session_id === NO_REPOSITORY_SESSION) return { ...row, repo: { label: row.repo.label, branch: row.repo.branch } };
    return row;
  });
fs.mkdirSync(spoolDir, { recursive: true });
fs.writeFileSync(path.join(state, "telemetry", "state.json"), JSON.stringify({ enabled: true }));
for (const harness of new Set(rows.map((row) => row.harness))) {
  const lines = rows.filter((row) => row.harness === harness).map((row) => JSON.stringify(row));
  fs.writeFileSync(path.join(spoolDir, `${harness}.jsonl`), `${lines.join("\n")}\n`);
}

const registry = defaultRegistry();
for (const [id, displayName] of [[SHARED, "scope-shared"], [IDLE, "scope-idle"], [MULTI, "scope-ignored"]]) {
  upsertRepository(registry, { id, kind: "git", displayName, providerUrl: `https://github.com/acme/${displayName}` });
}
hideRepository(registry, MULTI, { hidden: true });

// A repo with a real primary checkout for the Agents inspector routes. It has no telemetry, so the
// Tokens totals below are unchanged by it.
const INSPECT = "git:github.com/acme/scope-inspect";
fs.mkdirSync(path.join(tmp, "scope-inspect"));
const inspectRoot = fs.realpathSync(path.join(tmp, "scope-inspect"));
// Git hooks export these; inherited, they would point the fixture's commands at the outer repo.
const fixtureGitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete fixtureGitEnv[key];
const runGit = (...args) => {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: inspectRoot, encoding: "utf8", env: fixtureGitEnv });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
};
runGit("init", "-q", "-b", "main");
runGit("remote", "add", "origin", "https://github.com/acme/scope-inspect.git");
fs.writeFileSync(path.join(inspectRoot, "CLAUDE.md"), "# Inspect me\n");
fs.mkdirSync(path.join(inspectRoot, ".claude"));
fs.writeFileSync(path.join(inspectRoot, ".claude", "settings.json"), JSON.stringify({ env: { TOKEN: "route-secret-value" } }));
runGit("add", "-A");
runGit("commit", "-q", "-m", "init");
upsertRepository(registry, { id: INSPECT, kind: "git", displayName: "scope-inspect", providerUrl: "https://github.com/acme/scope-inspect" });
registerLocalRoot(registry, INSPECT, { rootId: rootId(inspectRoot), kind: "primary" });
registerLocalRootPath(registry, INSPECT, { rootId: rootId(inspectRoot), path: inspectRoot });
writeRegistry({ stateRoot: state, registry });

const countFor = (predicate) => rows.filter((row) => predicate(row.repo?.repository_id || null)).length;
let output = "";
const child = spawn(process.execPath, [path.join(root, "scripts/cli/main.mjs"), "web", "--no-open", "--port", "0", "--allow-zero-port"], {
  cwd: root,
  env: { ...process.env, HOME: tmp, ROBOREPO_STATE_ROOT: state, PORTAL_READY_FILE: ready },
  stdio: ["ignore", "pipe", "pipe"],
});
child.stdout.on("data", (part) => { output += part; });
child.stderr.on("data", (part) => { output += part; });

try {
  const deadline = Date.now() + 60_000;
  while (!fs.existsSync(ready)) {
    if (child.exitCode != null || Date.now() > deadline) throw new Error(`test portal failed to start: ${output}`);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  const port = fs.readFileSync(ready, "utf8").match(/ready:(\d+)/)[1];
  const get = async (urlPath) => {
    const response = await fetch(`http://127.0.0.1:${port}${urlPath}`);
    return { status: response.status, json: await response.json() };
  };
  const report = async (scope) => {
    const response = await get(`/api/data${scope ? `?repo=${scope}` : ""}`);
    assert.equal(response.status, 200, `report for ${scope || "all"}`);
    return response.json;
  };
  const sessionsOf = (data) => new Set(data.sessions.map((session) => session.session_id));

  // Selector data and scope keys are path-free.
  const { json: list } = await get("/api/repositories");
  assert.equal(JSON.stringify(list).includes(tmp), false, "repository list carries no local path");
  const keyOf = (displayName) => list.repositories.find((repository) => repository.displayName === displayName).urlKey;
  for (const repository of list.repositories) assert.match(repository.urlKey, URL_KEY_PATTERN);
  const sharedKey = keyOf("scope-shared");
  const idleKey = keyOf("scope-idle");

  // A, then B, then A again: each scope gets its own report, so no cached report leaks across.
  const sharedFirst = await report(sharedKey);
  const idle = await report(idleKey);
  const sharedAgain = await report(sharedKey);
  assert.equal(sharedFirst.event_count, countFor((id) => id === SHARED));
  assert.equal(idle.event_count, countFor((id) => id === IDLE));
  assert.deepEqual(sharedAgain, sharedFirst, "returning to a scope returns that scope's report");
  assert.notEqual(idle.event_count, sharedFirst.event_count);

  // Activity outside listed repos: unknown, ignored, and repository-less sessions, nothing listed,
  // and together with every listed repository it is exactly All repos.
  const all = await report(null);
  const outside = await report("_other");
  assert.equal(outside.event_count, countFor((id) => id !== SHARED && id !== IDLE));
  for (const session of [UNKNOWN_SESSION, HIDDEN_SESSION, NO_REPOSITORY_SESSION]) {
    assert.ok(sessionsOf(outside).has(session), `${session} is outside listed repos`);
  }
  for (const session of [...sessionsOf(sharedFirst), ...sessionsOf(idle)]) {
    assert.equal(sessionsOf(outside).has(session), false, `${session} belongs to a listed repository`);
  }
  assert.equal(sharedFirst.event_count + idle.event_count + outside.event_count, all.event_count, "listed + outside = all");

  // Unavailable keys answer with the explicit status, never all activity and never a server error.
  const multiKey = registry.repositories[MULTI].urlKey;
  for (const value of [multiKey, "nope", "Bad%20Key", encodeURIComponent(SHARED)]) {
    const response = await get(`/api/data?repo=${value}`);
    assert.equal(response.status, 404, `/api/data?repo=${value}`);
    assert.equal(response.json.error.code, "REPOSITORY_SCOPE_UNAVAILABLE");
    const plans = await get(`/api/plans?repo=${value}`);
    assert.equal(plans.status, 404, `/api/plans?repo=${value}`);
  }
  assert.equal((await get("/api/plans?repo=_other")).status, 404, "outside activity is Tokens-only");

  // Agents inspector routes: scoped only, primary checkout only, unavailable keys answer 404.
  const inspectKey = keyOf("scope-inspect");
  const inventory = await get(`/api/config/repository?repo=${inspectKey}`);
  assert.equal(inventory.status, 200);
  assert.equal(inventory.json.status, "ok");
  assert.equal(inventory.json.checkout.path, inspectRoot);
  assert.deepEqual(inventory.json.checkout.head, { kind: "branch", name: "main" });
  assert.deepEqual(inventory.json.entries.map((entry) => entry.path).sort(), [".claude/settings.json", "CLAUDE.md"]);
  assert.equal(JSON.stringify(inventory.json).includes("route-secret-value"), false, "config values never reach the browser");
  const source = await get(`/api/config/repository/source?repo=${inspectKey}&id=${encodeURIComponent("claude:CLAUDE.md")}`);
  assert.equal(source.status, 200);
  assert.equal(source.json.content, "# Inspect me\n");
  const settingsSource = await get(`/api/config/repository/source?repo=${inspectKey}&id=${encodeURIComponent("claude:.claude/settings.json")}`);
  assert.equal(JSON.stringify(settingsSource.json).includes("route-secret-value"), false);
  assert.equal((await get(`/api/config/repository/source?repo=${inspectKey}&id=${encodeURIComponent("claude:../outside")}`)).status, 404);
  const noCheckout = await get(`/api/config/repository?repo=${sharedKey}`);
  assert.equal(noCheckout.json.status, "checkout-unavailable", "a repo without a recorded checkout reads no files");
  assert.equal(noCheckout.json.entries, undefined);
  assert.equal((await get("/api/config/repository")).status, 400, "All repos has no repo inventory");
  for (const value of ["nope", multiKey, "_other"]) {
    const response = await get(`/api/config/repository?repo=${value}`);
    assert.equal(response.status, 404, `/api/config/repository?repo=${value}`);
    assert.equal((await get(`/api/config/repository/source?repo=${value}&id=claude:CLAUDE.md`)).status, 404);
  }

  // Once RoboRepo finds the unknown repository, its sessions leave _other with no spool change.
  const spoolBefore = fs.readdirSync(spoolDir).map((name) => fs.statSync(path.join(spoolDir, name)).mtimeMs);
  updateRegistry({
    stateRoot: state,
    mutate: (current) => {
      upsertRepository(current, { id: UNKNOWN, kind: "git", displayName: "scope-unknown" });
      return true;
    },
  });
  const outsideAfter = await report("_other");
  assert.equal(sessionsOf(outsideAfter).has(UNKNOWN_SESSION), false, "a found repository's sessions leave _other");
  assert.equal(outsideAfter.event_count, outside.event_count - countFor((id) => id === UNKNOWN));
  assert.deepEqual(fs.readdirSync(spoolDir).map((name) => fs.statSync(path.join(spoolDir, name)).mtimeMs), spoolBefore, "the spool did not change");

  // Repository discovery invalidates analysis too; Home keeps its warnings while the next
  // default analysis is pending, even if a scoped Tokens view has already been analyzed.
  const tokensForShared = async () => {
    const { json: home } = await get("/api/home");
    return home.repositories.find((repository) => repository.repositoryId === SHARED).domains.tokens;
  };
  const pendingTokens = await tokensForShared();
  assert.equal(pendingTokens.status, "stale");
  assert.ok(pendingTokens.data.warningCount > 0, "Home retains analyzed warnings after repository discovery");
  await report(null);
  const freshTokens = await tokensForShared();
  assert.equal(freshTokens.status, "available");
  assert.deepEqual(freshTokens.data, pendingTokens.data);

  const appended = { ...rows.find((row) => row.repo?.repository_id === SHARED), ts: "2026-10-01T00:00:00.000Z", capture_id: "cap_0000000000000099", call_id: "home-refresh" };
  fs.appendFileSync(path.join(spoolDir, `${appended.harness}.jsonl`), `${JSON.stringify(appended)}\n`);
  const afterCapture = await tokensForShared();
  assert.equal(afterCapture.status, "stale");
  assert.deepEqual(afterCapture.data, freshTokens.data, "new captures do not clear Home's warnings");
  await report(idleKey);
  assert.deepEqual((await tokensForShared()).data, freshTokens.data, "scoped analysis cannot replace Home's all-repository warnings");
  await report(null);
  assert.equal((await tokensForShared()).status, "available");

  for (let index = 0; index < 33; index += 1) {
    assert.equal((await get(`/api/data?model=uncaptured-${index}`)).status, 200);
  }
  const afterEviction = await tokensForShared();
  assert.equal(afterEviction.status, "stale");
  assert.ok(afterEviction.data.warningCount > 0, "filtered report cache eviction cannot clear Home's warnings");

  for (const name of fs.readdirSync(spoolDir)) fs.writeFileSync(path.join(spoolDir, name), "");
  await report(null);
  const emptyTokens = await tokensForShared();
  assert.equal(emptyTokens.status, "available");
  assert.equal(emptyTokens.data.warningCount, 0, "fresh analysis can legitimately clear warnings");
  fs.appendFileSync(path.join(spoolDir, `${appended.harness}.jsonl`), `${JSON.stringify(appended)}\n`);
  const pendingAfterEmpty = await tokensForShared();
  assert.equal(pendingAfterEmpty.status, "stale");
  assert.equal(pendingAfterEmpty.data.warningCount, 0, "pending analysis retains the latest result without resurrecting old warnings");

  console.log("repository scope portal checks passed");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
