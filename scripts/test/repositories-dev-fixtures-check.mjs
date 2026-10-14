#!/usr/bin/env node
// Development fixtures are registry records no reader sees unless `roborepo dev start` turned dev
// mode on, and saving the registry must never drop them.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { recordRepositoryDiscovery, loadRepositoriesPayload } from "../cli/repositories.mjs";
import { devFixturesEnabled, isFixtureRepository, loadRegistry, setDevFixturesEnabled } from "../../modules/repositories/index.mjs";

const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-dev-fixtures-"));
const stateRoot = path.join(tempRoot, "state");
const record = (id, displayName) => recordRepositoryDiscovery({
  repositoryId: id, kind: "git", displayName, source: "developer-runtime", evidence: "git-remote", confidence: "high", localRoot: `root-${displayName}`, stateRoot,
});

try {
  const fixtureId = "git:github.com/example/shared-stack-fixture";
  const realId = "git:github.com/example/alpha";
  assert.ok(isFixtureRepository(fixtureId));
  assert.ok(!isFixtureRepository(realId), "a repository without the -fixture suffix is real");
  assert.ok(!isFixtureRepository("git:github.com/kirinmurphy/roborepo-fixture"), "only the example owner marks a fixture");

  record(fixtureId, "shared-stack-fixture");
  record(realId, "alpha");

  assert.equal(devFixturesEnabled({ stateRoot }), false, "dev mode is off by default");
  assert.deepEqual(Object.keys(loadRegistry({ stateRoot }).repositories), [realId], "readers do not see fixtures");
  assert.deepEqual(loadRepositoriesPayload({ stateRoot }).repositories.map((repository) => repository.repositoryId), [realId], "the repository list omits fixtures");

  // Saving through the writers must keep the fixture the readers could not see.
  record(realId, "alpha");
  recordRepositoryDiscovery({ repositoryId: realId, kind: "git", displayName: "alpha", source: "plans", evidence: "configured-scan-root", confidence: "high", stateRoot });
  setDevFixturesEnabled({ stateRoot, enabled: true });
  assert.ok(devFixturesEnabled({ stateRoot }));
  assert.deepEqual(Object.keys(loadRegistry({ stateRoot }).repositories).sort(), [fixtureId, realId].sort(), "dev mode shows fixtures, which survived a write");
  assert.equal(loadRepositoriesPayload({ stateRoot }).repositories.length, 2);

  setDevFixturesEnabled({ stateRoot, enabled: false });
  assert.equal(devFixturesEnabled({ stateRoot }), false, "dev stop turns it off again");
  assert.deepEqual(Object.keys(loadRegistry({ stateRoot }).repositories), [realId]);
  console.log("repositories-dev-fixtures-check passed");
} finally {
  fs.rmSync(tempRoot, { recursive: true, force: true });
}
