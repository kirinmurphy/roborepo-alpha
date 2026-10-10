#!/usr/bin/env node
// Agent-session repository reconciliation (pljvmyh): telemetry may enrich a repository source
// already found, but it must never create a Home/Plans record on its own.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  defaultRegistry,
  loadRegistry,
  localRepositoryIdForRoot,
  updateRegistry,
  upsertRepository,
  writeRegistry,
} from "../../modules/repositories/index.mjs";
import { identifyRepositoryRoot } from "../cli/repository-source-refresh.mjs";

const tempRoot = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "telemetry-repository-reconcile-")));
const stateRoot = path.join(tempRoot, "state");
const checkout = path.join(tempRoot, "local-only");
const originalStateRoot = process.env.ROBOREPO_STATE_ROOT;

try {
  fs.mkdirSync(checkout, { recursive: true });
  assert.equal(spawnSync("git", ["init", "-q", "-b", "main"], { cwd: checkout }).status, 0);

  const sourceIdentity = identifyRepositoryRoot(checkout);
  const captureIdentity = localRepositoryIdForRoot(checkout);
  assert.equal(sourceIdentity.repositoryId, captureIdentity, "folder discovery and telemetry capture derive the same local id");

  const registry = defaultRegistry();
  upsertRepository(registry, {
    id: sourceIdentity.repositoryId,
    kind: "local",
    displayName: "local-only",
  });
  writeRegistry({ stateRoot, registry });

  const laterKnownId = "git:github.com/example/later-known";
  const neverKnownId = "git:github.com/example/agent-only";
  const spoolDir = path.join(stateRoot, "telemetry", "spool");
  fs.mkdirSync(spoolDir, { recursive: true });
  fs.writeFileSync(path.join(spoolDir, "codex.jsonl"), [
    { repo: { repository_id: sourceIdentity.repositoryId } },
    { repo: { repository_id: laterKnownId } },
    { repo: { repository_id: neverKnownId } },
  ].map((row) => JSON.stringify(row)).join("\n") + "\n");

  process.env.ROBOREPO_STATE_ROOT = stateRoot;
  const { reconcileTelemetryRepositories } = await import("../cli/telemetry.mjs");
  reconcileTelemetryRepositories();

  let after = loadRegistry({ stateRoot });
  assert.ok(after.repositories[sourceIdentity.repositoryId].discoveries.some((entry) => entry.source === "telemetry"));
  assert.equal(after.repositories[laterKnownId], undefined, "an agent-only repository is not created");
  assert.equal(after.repositories[neverKnownId], undefined, "unmatched agent activity stays outside the registry");

  // The spool is unchanged. Adding a matching source record must still invalidate reconciliation
  // so the earlier session evidence attaches on the next repository-list load.
  updateRegistry({
    stateRoot,
    mutate(current) {
      upsertRepository(current, { id: laterKnownId, kind: "git", displayName: "later-known" });
      return true;
    },
  });
  reconcileTelemetryRepositories();
  after = loadRegistry({ stateRoot });
  assert.ok(after.repositories[laterKnownId].discoveries.some((entry) => entry.source === "telemetry"));
  assert.equal(after.repositories[neverKnownId], undefined);

  console.log("telemetry repository reconcile checks passed");
} finally {
  if (originalStateRoot === undefined) delete process.env.ROBOREPO_STATE_ROOT;
  else process.env.ROBOREPO_STATE_ROOT = originalStateRoot;
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
