// A reserved plans worktree beside a checkout, for checks that only read the store and need no
// remote. Files are keyed by their path under `plans/`. `plan-git-fixture.mjs` builds the full
// origin-and-store setup for checks that exercise commits and pushes.
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { LIFECYCLE_MODEL } from "../../../modules/plan-suite/lifecycle-manifest.mjs";

export function addPlansStore(checkout, files = {}) {
  const root = path.join(`${checkout}.plans`, "repo_plans");
  fs.mkdirSync(path.dirname(root), { recursive: true });
  const added = spawnSync("git", ["-C", checkout, "worktree", "add", "-q", "-b", "repo-plans", root, "HEAD"], { encoding: "utf8" });
  if (added.status !== 0) throw new Error(`could not add the plans worktree: ${added.stderr}`);
  // `plans init` creates every lifecycle folder, and cleanup reads a missing one as a damaged store.
  for (const folder of LIFECYCLE_MODEL.folders) fs.mkdirSync(path.join(root, "plans", folder), { recursive: true });
  writePlansFiles(root, files);
  return root;
}

export function writePlansFiles(storeRoot, files) {
  for (const [file, content] of Object.entries(files)) {
    const target = path.join(storeRoot, "plans", file);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, content);
  }
}
