#!/usr/bin/env node
// The shared repository scope against a real served portal: a seeded registry and the committed
// fixture spool, so /api/data's analysis cache, the registry, and Activity outside listed repos
// (`_other`) are exercised together. Route and resolver details are in repository-scope-check.mjs.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import {
  URL_KEY_PATTERN, defaultRegistry, hideRepository, updateRegistry, upsertRepository, writeRegistry,
} from "../../modules/repositories/index.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "repository-scope-portal-"));
const ready = path.join(tmp, "ready");
const state = path.join(tmp, "state");
const spoolDir = path.join(state, "telemetry", "spool");

// The fixture rows are remapped onto this check's own repositories: the portal forgets the dev
// fixture ids at startup (they are Home's mock repositories). Listed: SHARED and IDLE. Ignored:
// MULTI. UNKNOWN is in the spool but not the registry, and one session carries no repository.
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
for (const harness of new Set(rows.map((row) => row.harness))) {
  const lines = rows.filter((row) => row.harness === harness).map((row) => JSON.stringify(row));
  fs.writeFileSync(path.join(spoolDir, `${harness}.jsonl`), `${lines.join("\n")}\n`);
}

const registry = defaultRegistry();
for (const [id, displayName] of [[SHARED, "scope-shared"], [IDLE, "scope-idle"], [MULTI, "scope-ignored"]]) {
  upsertRepository(registry, { id, kind: "git", displayName, providerUrl: `https://github.com/acme/${displayName}` });
}
hideRepository(registry, MULTI, { hidden: true });
writeRegistry({ stateRoot: state, registry });

const countFor = (predicate) => rows.filter((row) => predicate(row.repo?.repository_id || null)).length;
let output = "";
const child = spawn(process.execPath, [path.join(root, "scripts/cli/main.mjs"), "web", "--no-open", "--port", "0", "--allow-zero-port"], {
  cwd: root,
  env: { ...process.env, HOME: tmp, ROBOREPO_STATE_DIR: state, PORTAL_READY_FILE: ready },
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

  console.log("repository scope portal checks passed");
} finally {
  child.kill("SIGTERM");
  if (child.exitCode == null) await new Promise((resolve) => child.once("exit", resolve));
  fs.rmSync(tmp, { recursive: true, force: true });
}
