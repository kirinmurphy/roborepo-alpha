#!/usr/bin/env node
// The portal's /api/packages routes against a real portal server on a temp state root, with a
// file:// fixture repository. Covers: each route returns the package service's result; a refusal
// keeps the service's message (the same text the CLI prints), code, details, and mapped HTTP
// status; an install bound to a stale preview is refused with the new plan; an unconfirmed update
// returns the change and a confirmed one re-applies an active package, logged as the portal
// request; another route answers while a git refresh runs; and removal deletes a git copy but
// never a folder package's files.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { pathToFileURL } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";
import { liveClaudeRules, makeSourceRoots, repoRoot, runCli } from "./fixtures/package-sources.mjs";
import { PackageServiceError } from "../cli/package-service.mjs";
import { statusForServiceError } from "../cli/portal-routes-packages.mjs";
import { runPackageServiceInChild } from "../cli/package-service-runner.mjs";

// Each service code maps to one HTTP status; anything that is not a service refusal is a 500.
const EXPECTED_STATUS = { usage: 400, invalid: 400, ambiguous: 409, confirmationRequired: 409, refused: 409, unavailable: 503 };
for (const [code, status] of Object.entries(EXPECTED_STATUS)) {
  assert.equal(statusForServiceError(new PackageServiceError("x", { code })), status, `${code} maps to ${status}`);
}
assert.equal(statusForServiceError(new PackageServiceError("x", { code: "other" })), 500);
assert.equal(statusForServiceError(new Error("x")), 500);

const roots = makeSourceRoots("roborepo-portal-package-routes-");
const restoreGit = isolateGitConfig(roots.tmp);

// `git` on the server's PATH: the real one, slowed down while `slowFlag` exists, so a refresh is
// still running when another request arrives.
const realGit = spawnSync("sh", ["-c", "command -v git"], { encoding: "utf8" }).stdout.trim();
const binDir = path.join(roots.tmp, "bin");
const slowFlag = path.join(roots.tmp, "slow-git");
fs.mkdirSync(binDir, { recursive: true });
fs.writeFileSync(path.join(binDir, "git"), `#!/bin/sh\nif [ -e '${slowFlag}' ]; then sleep 3; fi\nexec '${realGit}' "$@"\n`, { mode: 0o755 });
// The server runs from this checkout, since the portal imports built-in package scripts the mini
// app root does not have; the state root, HOME, and workspace stay temporary.
const env = {
  ...Object.fromEntries(Object.entries(roots.env).filter(([key]) => !key.startsWith("GIT_CONFIG") && key !== "ROBOREPO_APP_ROOT")),
  GIT_CONFIG_GLOBAL: process.env.GIT_CONFIG_GLOBAL,
  GIT_CONFIG_NOSYSTEM: "1",
  PATH: `${binDir}${path.delimiter}${process.env.PATH}`,
};

function git(cwd, ...args) {
  const result = spawnSync(realGit, ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.invalid", "-c", "init.defaultBranch=main", ...args], { cwd, encoding: "utf8" });
  assert.equal(result.status, 0, `git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

const manifest = (id) => JSON.stringify({
  schemaVersion: 1,
  id,
  label: `Route ${id}`,
  description: `Route fixture ${id}.`,
  presentation: { category: "integrations" },
  resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
});

function makeRepo(dir, files) {
  fs.mkdirSync(dir, { recursive: true });
  git(dir, "init", "-q");
  const commit = (next) => {
    for (const [rel, content] of Object.entries(next)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), content);
    }
    git(dir, "add", "-A");
    git(dir, "commit", "-q", "-m", "fixture");
    return git(dir, "rev-parse", "HEAD");
  };
  return { url: pathToFileURL(dir).href, first: commit(files), commit };
}

const cli = (...args) => runCli(env, args);

let server = null;
try {
  const repo = makeRepo(path.join(roots.tmp, "repos", "team"), {
    "packages/routetool/package.config.json": manifest("routetool"),
    "packages/routetool/rules.md": "## Route tool v1\n",
  });
  const folder = path.join(roots.tmp, "folder-source");
  fs.mkdirSync(path.join(folder, "routefolder"), { recursive: true });
  fs.writeFileSync(path.join(folder, "routefolder", "package.config.json"), manifest("routefolder"));
  fs.writeFileSync(path.join(folder, "routefolder", "rules.md"), "## Route folder\n");

  const readyFile = path.join(roots.tmp, "portal.ready");
  server = spawn(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "web", "--no-open", "--port", "0", "--allow-zero-port"], {
    cwd: repoRoot,
    env: { ...env, PORTAL_READY_FILE: readyFile },
    stdio: ["ignore", "ignore", "inherit"],
  });
  const port = await waitForPort(readyFile);
  const base = `http://127.0.0.1:${port}`;
  const html = await (await fetch(`${base}/agents`)).text();
  const token = html.match(/name="cli-portal-token" content="([^"]+)"/)?.[1];
  assert.ok(token, "the Agents page carries the portal token");

  const call = async (method, urlPath, body) => {
    const response = await fetch(`${base}${urlPath}`, {
      method,
      headers: { "Content-Type": "application/json", "X-Cli-Portal-Token": token },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: response.status, body: await response.json() };
  };
  const ok = async (method, urlPath, body) => {
    const result = await call(method, urlPath, body);
    assert.equal(result.status, 200, `${method} ${urlPath}: ${JSON.stringify(result.body)}`);
    return result.body.result;
  };

  // Sources: a folder is added in process, a git URL in a child; both return the service result.
  const addedFolder = await ok("POST", "/api/packages/sources", { location: folder, id: "routefolders" });
  assert.equal(addedFolder.source.id, "routefolders");
  assert.deepEqual(addedFolder.packages, ["routefolder"]);
  const addedGit = await ok("POST", "/api/packages/sources", { location: repo.url, id: "team" });
  assert.equal(addedGit.source.type, "git");
  assert.deepEqual(addedGit.packages, ["routetool"]);
  const listed = await ok("GET", "/api/packages/sources");
  assert.deepEqual(listed.map((source) => source.id).sort(), ["builtin", "local", "routefolders", "team"]);
  assert.deepEqual((await ok("GET", "/api/packages/sources/team")).packages, ["routetool"]);

  // A refusal keeps the message the CLI prints for the same case, its code, and its status.
  const duplicate = await call("POST", "/api/packages/sources", { location: repo.url, id: "team" });
  const cliDuplicate = cli("package", "source", "add", repo.url, "--id", "team");
  assert.equal(duplicate.status, 409);
  assert.equal(duplicate.body.error.code, "refused");
  assert.equal(duplicate.body.error.message, cliDuplicate.stderr.trim(), "the portal and the CLI print the same refusal");
  const unknown = await call("GET", "/api/packages/sources/nope");
  assert.equal(unknown.status, 400);
  assert.equal(unknown.body.error.code, "usage");
  const builtinRemove = await call("DELETE", "/api/packages/sources/builtin");
  assert.equal(builtinRemove.status, 409);
  assert.equal(builtinRemove.body.error.message, cli("package", "source", "remove", "builtin").stderr.trim());
  assert.equal((await call("POST", "/api/packages/install", {})).status, 400, "a malformed body is a usage refusal");

  // Turning a source off and on.
  assert.equal((await ok("POST", "/api/packages/sources/routefolders/enabled", { enabled: false })).enabled, false);
  assert.equal((await ok("POST", "/api/packages/sources/routefolders/enabled", { enabled: true })).enabled, true);

  // Install is bound to the preview's plan: a different plan is refused with the current one.
  const preview = await ok("GET", "/api/packages/install-preview?ref=team%2Froutetool");
  assert.deepEqual(preview.plan, [{ qualifiedName: "team/routetool", revision: repo.first }]);
  const stale = await call("POST", "/api/packages/install", { ref: "team/routetool", expectedPlan: [{ qualifiedName: "team/routetool", revision: "0".repeat(40) }] });
  assert.equal(stale.status, 409);
  assert.equal(stale.body.error.code, "confirmationRequired");
  assert.equal(stale.body.error.details.planChanged, true);
  assert.deepEqual(stale.body.error.details.plan, preview.plan, "the refusal carries the plan to show again");
  const installed = await ok("POST", "/api/packages/install", { ref: "team/routetool", expectedPlan: preview.plan });
  assert.equal(installed.installed[0].revision, repo.first);

  // The view the page reads is the one `package list --json` prints.
  const view = await ok("GET", "/api/packages");
  const cliView = JSON.parse(cli("package", "list", "--json").stdout);
  assert.deepEqual(view, cliView, "the portal and the CLI read the same package view");
  const row = view.packages.find((entry) => entry.qualifiedName === "team/routetool");
  assert.equal(row.installed, true);
  assert.equal(row.active, false);
  assert.equal(row.tab, "third-party");

  // Enable from the CLI; the update from the portal re-applies it.
  assert.equal(cli("package", "enable", "routetool").status, 0);
  assert.match(liveClaudeRules(roots.home), /Route tool v1/);
  const second = repo.commit({ "packages/routetool/rules.md": "## Route tool v2\n" });
  const unconfirmed = await call("POST", "/api/packages/update", { ref: "routetool" });
  assert.equal(unconfirmed.status, 409);
  assert.equal(unconfirmed.body.error.code, "confirmationRequired");
  const change = unconfirmed.body.error.details.change;
  assert.deepEqual([change.from, change.to], [repo.first, second]);
  assert.deepEqual(change.files.changed, ["rules.md"]);
  assert.equal(cli("package", "list", "--json").status, 0);
  assert.equal(JSON.parse(cli("package", "list", "--json").stdout).packages.find((entry) => entry.id === "routetool").revision, repo.first, "an unconfirmed update moves nothing");
  const unbound = await call("POST", "/api/packages/update", { ref: "routetool", confirmed: true });
  assert.equal(unbound.status, 400, "a confirmation must name the change it confirms");
  assert.equal(unbound.body.error.code, "usage");
  const movedFrom = await call("POST", "/api/packages/update", { ref: "routetool", confirmed: true, expectedRevision: second, expectedFrom: second });
  assert.equal(movedFrom.status, 409, "a confirmation bound to another starting revision asks again");
  assert.equal(movedFrom.body.error.details.change.from, repo.first);
  const updated = await ok("POST", "/api/packages/update", { ref: "routetool", confirmed: true, expectedRevision: change.to, expectedFrom: change.from });
  assert.equal(updated.reapplied, true, "an active package is re-applied");
  assert.match(liveClaudeRules(roots.home), /Route tool v2/);
  const writes = fs.readFileSync(path.join(roots.stateRoot, "logs", "config-writes.jsonl"), "utf8").trim().split("\n").map((line) => JSON.parse(line));
  assert.ok(writes.some((entry) => entry.actor === "portal POST /api/packages/update"), "the child's writes are logged as the portal request");

  // A slow refresh runs in a child: another route answers before it finishes.
  repo.commit({ "packages/routetool/rules.md": "## Route tool v3\n" });
  fs.writeFileSync(slowFlag, "");
  const started = Date.now();
  const refreshing = call("POST", "/api/packages/sources/team/refresh");
  await new Promise((resolve) => setTimeout(resolve, 300));
  await ok("GET", "/api/packages/sources");
  const answeredAfter = Date.now() - started;
  const refreshed = await refreshing;
  const refreshTook = Date.now() - started;
  // A child that runs past its ceiling is stopped and the call fails with a message.
  await assert.rejects(
    runPackageServiceInChild("refreshSources", ["team"], { env, actor: "portal POST /api/packages/sources/team/refresh", timeoutMs: 1000 }),
    /did not finish within .* and was stopped/,
  );
  fs.rmSync(slowFlag);
  assert.equal(refreshed.status, 200, JSON.stringify(refreshed.body));
  assert.equal(refreshed.body.result[0].changed, true);
  assert.ok(refreshTook >= 3000, `the refresh ran slow git (${refreshTook} ms)`);
  assert.ok(answeredAfter < refreshTook - 1000, `another route answered at ${answeredAfter} ms, before the refresh ended at ${refreshTook} ms`);
  assert.equal((await ok("GET", "/api/packages")).packages.find((entry) => entry.id === "routetool").updateAvailable, true);

  // Remove: an active git package is turned off first and its copy deleted.
  const copy = JSON.parse(fs.readFileSync(path.join(roots.stateRoot, "packages", "package-lock.json"), "utf8")).packages.routetool.installedPath;
  const removed = await ok("DELETE", "/api/packages/installed/team%2Froutetool");
  assert.equal(removed.removed, true);
  assert.equal(removed.disabled, true);
  assert.equal(removed.deletedCopy, true);
  assert.ok(!fs.existsSync(copy), "the installed copy is deleted");
  assert.doesNotMatch(liveClaudeRules(roots.home), /Route tool/);

  // A folder package is used in place; removing it never touches the folder.
  const folderPreview = await ok("GET", "/api/packages/install-preview?ref=routefolders%2Froutefolder");
  await ok("POST", "/api/packages/install", { ref: "routefolders/routefolder", expectedPlan: folderPreview.plan });
  const removedFolder = await ok("DELETE", "/api/packages/installed/routefolders%2Froutefolder");
  assert.equal(removedFolder.removed, true);
  assert.ok(fs.existsSync(path.join(folder, "routefolder", "package.config.json")), "a folder package's files stay");

  // Removing the sources.
  assert.equal((await ok("DELETE", "/api/packages/sources/team")).removed, "team");
  assert.equal((await ok("DELETE", "/api/packages/sources/routefolders")).removed, "routefolders");
  assert.deepEqual((await ok("GET", "/api/packages/sources")).map((source) => source.id).sort(), ["builtin", "local"]);
  console.log("portal package routes: ok");
} finally {
  server?.kill("SIGTERM");
  restoreGit();
  roots.cleanup();
}

function waitForPort(readyFile, timeoutMs = 20_000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const check = () => {
      const match = fs.existsSync(readyFile) && fs.readFileSync(readyFile, "utf8").match(/ready:(\d+)/);
      if (match) return resolve(Number(match[1]));
      if (server.exitCode !== null) return reject(new Error("portal server exited before it was ready"));
      if (Date.now() - start > timeoutMs) return reject(new Error("timed out waiting for the portal server"));
      setTimeout(check, 100);
    };
    check();
  });
}
