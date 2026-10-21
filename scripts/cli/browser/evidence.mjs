// Where browser evidence lives: one flat directory under the state root, registered as the
// `browser-evidence` retention store. Every artifact a run reports is placed here first, so a
// result never cites a provider's temp directory that is about to disappear.

import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { findRetentionStore, measureFileSet } from "../../../modules/retention/index.mjs";

const EXTENSIONS = Object.freeze({ screenshot: ".png", video: ".webm", trace: ".zip" });

// Apply the store's policy before a run writes anything, so pruning can never take the artifacts
// the current run is about to report.
export function pruneEvidence(stateRoot) {
  const store = findRetentionStore(stateRoot, "browser-evidence");
  const verdict = measureFileSet({ dirPath: store.target, policy: store.policy, filter: store.filter });
  for (const filePath of verdict.files) fs.rmSync(filePath, { force: true });
  return verdict.files.length;
}

// One run's view of the store. `reserve` hands out a path for a provider to write to directly;
// `adopt` moves a file the browser wrote elsewhere (a video, a test-runner attachment) into place.
export function createEvidenceRun(stateRoot, { now = new Date() } = {}) {
  const dir = findRetentionStore(stateRoot, "browser-evidence").target;
  const runId = `${now.toISOString().replace(/[-:]/g, "").replace(/\.\d+Z$/, "Z")}-${randomBytes(3).toString("hex")}`;
  const artifacts = [];

  function reserve(type) {
    if (!EXTENSIONS[type]) throw new Error(`unknown evidence type: ${type}`);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${runId}-${artifacts.length + 1}-${type}${EXTENSIONS[type]}`);
    artifacts.push({ type, path: filePath });
    return filePath;
  }

  function adopt(sourcePath, type) {
    const target = reserve(type);
    try {
      fs.renameSync(sourcePath, target);
    } catch {
      // A rename across devices (temp dir on another volume) fails; copy instead.
      fs.copyFileSync(sourcePath, target);
      fs.rmSync(sourcePath, { force: true });
    }
    return target;
  }

  // Only files that actually landed are reported. A capture that failed after its path was reserved
  // leaves nothing to cite, and citing it anyway would be fabricated evidence.
  function written() {
    return artifacts.filter((artifact) => fs.existsSync(artifact.path));
  }

  return { runId, dir, reserve, adopt, written };
}
