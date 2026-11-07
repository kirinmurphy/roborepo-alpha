import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isolateGitConfig } from "./lib/git-config.mjs";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-delivery-"));
const cli = fileURLToPath(new URL("../cli/main.mjs", import.meta.url));
isolateGitConfig(root);

try {
  const source = path.join(root, "source");
  const checkout = path.join(root, "checkout");
  git(root, "init", "-b", "main", source);
  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Initial");
  git(root, "clone", source, checkout);
  git(checkout, "branch", "sentinel");
  const initial = git(checkout, "rev-parse", "HEAD");

  git(source, "-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "--allow-empty", "-m", "Advance");
  const latest = git(source, "rev-parse", "HEAD");
  git(source, "tag", "remote-tag");
  git(checkout, "config", "--add", "remote.origin.fetch", "+refs/heads/main:refs/heads/sentinel");
  git(checkout, "config", "fetch.pruneTags", "true");
  git(checkout, "config", "remote.origin.tagOpt", "--tags");
  git(checkout, "tag", "local-tag");
  passed(delivery(checkout, ["fetch", "origin"]));
  assert.equal(git(checkout, "rev-parse", "refs/remotes/origin/main"), latest);
  assert.equal(git(checkout, "rev-parse", "refs/heads/sentinel"), initial);
  assert.equal(git(checkout, "tag", "--list"), "local-tag");

  for (const args of [["--all"], ["origin", "--tags"], ["origin", "main:sentinel"], [source], ["missing"]]) {
    refused(delivery(checkout, ["fetch", ...args]), /remote|usage/i);
  }
  console.log("✓ Guarded fetch refreshed origin/main and preserved local branches and tags.");

  git(checkout, "switch", "-c", "feature/check");
  git(checkout, "config", "branch.feature/check.remote", "origin");
  git(checkout, "config", "branch.feature/check.merge", "refs/heads/feature/check");
  git(checkout, "remote", "set-url", "origin", "git@github.com:example/project.git");
  const pr = {
    number: 42, headRefName: "feature/check", headRefOid: initial, baseRefName: "main",
    isCrossRepository: false, isDraft: true, state: "OPEN", url: "https://github.com/example/project/pull/42",
  };
  const run = {
    databaseId: 73, headBranch: "feature/check", headSha: initial, status: "completed", conclusion: "failure",
    url: "https://github.com/example/project/actions/runs/73",
  };
  if (process.platform === "win32") {
    console.log("skip: fake gh executable checks require a POSIX executable fixture");
  } else {
    const gh = createFakeGh();
    const runDelivery = (args, prs = [pr], workflow = run, configChange = null) => {
      fs.writeFileSync(gh.log, "");
      return delivery(checkout, args, {
        PATH: `${gh.dir}${path.delimiter}${process.env.PATH}`,
        FAKE_GH_LOG: gh.log,
        FAKE_GH_PRS: JSON.stringify(prs),
        FAKE_GH_RUN: JSON.stringify(workflow),
        FAKE_GH_CONFIG_CHANGE: JSON.stringify(configChange),
      });
    };
    const calls = () => fs.readFileSync(gh.log, "utf8").trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));

    const body = "--title=fake\nA multiline PR body with $(literal text)";
    const bodyFile = path.join(root, "body.md");
    fs.writeFileSync(bodyFile, body);
    passed(runDelivery(["pr-body", bodyFile]));
    assert.deepEqual(calls().at(-1), {
      args: ["pr", "edit", "42", "--repo", "github.com/example/project", "--body-file", "-"], input: body,
    });
    passed(runDelivery(["pr-ready"]));
    assert.deepEqual(calls().at(-1).args, ["pr", "ready", "42", "--repo", "github.com/example/project"]);
    passed(runDelivery(["retry-ci", "73"]));
    assert.deepEqual(calls().at(-1).args, ["run", "rerun", "73", "--repo", "github.com/example/project", "--failed"]);

    for (const patch of [
      { headRefName: "another-branch" }, { headRefOid: latest }, { isCrossRepository: true },
      { url: "https://github.com/other/project/pull/42" }, { state: "CLOSED" }, { baseRefName: "feature/check" },
    ]) {
      refused(runDelivery(["pr-ready"], [{ ...pr, ...patch }]), /pull request/i);
      assert.equal(calls().length, 2, "refusal stops before mutation");
    }
    refused(runDelivery(["pr-body", bodyFile], [pr, { ...pr, number: 43, url: "https://github.com/example/project/pull/43" }]), /pull request/i);
    for (const patch of [
      { headSha: latest }, { headBranch: "another-branch" }, { databaseId: 74 }, { conclusion: "success" },
      { status: "in_progress" }, { url: "https://github.com/other/project/actions/runs/73" },
    ]) {
      refused(runDelivery(["retry-ci", "73"], [pr], { ...run, ...patch }), /run/i);
      assert.equal(calls().length, 3, "refusal stops before rerun");
    }
    for (const args of [["pr-ready", "42"], ["pr-body", bodyFile, "--title"], ["retry-ci", "--failed"], ["retry-ci", "73", "--debug"]]) {
      refused(runDelivery(args), /usage/i);
      assert.deepEqual(calls(), []);
    }

    git(checkout, "remote", "add", "replacement", "git@github.com:example/project.git");
    for (const [key, changed, original] of [
      ["remote.origin.url", "https://github.com/example/project.git", "git@github.com:example/project.git"],
      ["remote.origin.pushurl", "https://github.com/example/project.git", null],
      ["branch.feature/check.remote", "replacement", "origin"],
      ["branch.feature/check.merge", "refs/heads/another-branch", "refs/heads/feature/check"],
    ]) {
      const result = runDelivery(["pr-ready"], [pr], run, [key, changed]);
      assert.equal(result.status, 1, result.stderr || result.stdout);
      assert.equal(calls().length, 2, "changed upstream configuration stops before mutation");
      if (original === null) git(checkout, "config", "--unset", key);
      else git(checkout, "config", key, original);
    }

    git(checkout, "remote", "set-url", "origin", "file://github.com/example/project.git");
    refused(runDelivery(["pr-ready"]), /remote|repository/i);
    assert.deepEqual(calls(), []);
    git(checkout, "remote", "set-url", "origin", "git@github.com:example/project.git");
    git(checkout, "switch", "main");
    refused(runDelivery(["pr-ready"]), /feature branch/i);
    assert.equal(calls().length, 1);
    git(checkout, "switch", "feature/check");
    git(checkout, "config", "remote.origin.pushurl", "git@github.com:other/project.git");
    refused(runDelivery(["pr-ready"]), /remote|repository/i);
    assert.deepEqual(calls(), []);
    console.log("✓ GitHub guards accepted the current PR head and refused mismatched PRs and stale runs.");
  }
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function git(cwd, ...args) {
  return passed(spawnSync("git", args, { cwd, encoding: "utf8" })).trim();
}

function delivery(cwd, args, env = {}) {
  return spawnSync(process.execPath, [cli, "delivery", ...args], {
    cwd, env: { ...process.env, ...env }, encoding: "utf8",
  });
}

function passed(result) {
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return result.stdout;
}

function refused(result, pattern) {
  assert.equal(result.status, 1, result.stderr || result.stdout);
  assert.match(result.stderr, pattern);
}

function createFakeGh() {
  const dir = path.join(root, "bin");
  const log = path.join(root, "gh.log");
  fs.mkdirSync(dir);
  fs.writeFileSync(path.join(dir, "gh"), `#!/usr/bin/env node
const fs = require("node:fs");
const args = process.argv.slice(2);
const input = args.includes("--body-file") ? fs.readFileSync(0, "utf8") : "";
fs.appendFileSync(process.env.FAKE_GH_LOG, JSON.stringify({ args, input }) + "\\n");
if (args[0] === "repo" && args[1] === "view") process.stdout.write(JSON.stringify({ defaultBranchRef: { name: "main" }, nameWithOwner: "example/project", url: "https://github.com/example/project" }));
if (args[0] === "pr" && args[1] === "list") {
  const change = JSON.parse(process.env.FAKE_GH_CONFIG_CHANGE || "null");
  if (change) {
    const { spawnSync } = require("node:child_process");
    const result = spawnSync("git", ["config", ...change], { encoding: "utf8" });
    if (result.status !== 0) throw new Error(result.stderr);
  }
  process.stdout.write(process.env.FAKE_GH_PRS);
}
if (args[0] === "run" && args[1] === "view") process.stdout.write(process.env.FAKE_GH_RUN);
`, { mode: 0o755 });
  return { dir, log };
}
