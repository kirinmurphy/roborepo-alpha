// Install, remove, and check the manifest rows whose target RoboRepo shares with package installs.
// A `managed_copy` row owns its whole target, so once a package merges a hook into
// ~/.codex/hooks.json or copies a script into ~/.codex/hooks/, the core copy collides with it and
// installs nothing. These two kinds own only their own part of the target instead:
//
//   hook_fragment  a hooks file. The source's `hooks` map merges through the provider's hooks.merge
//                  (Codex appends, so hooks the user already trusted keep their positions), and
//                  removal unmerges exactly those entries.
//   managed_files  a directory. Each source file is copied and tracked by hash, so files packages
//                  add beside them are never compared, staged, or removed (managed-files-row.mjs).
//
// Bundle apply (presets.mjs) imports these functions; the bash and PowerShell installers call the
// CLI entry at the bottom so all three share one implementation.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { mergeHooksInto, unmergeHooksFrom } from "./hook-composition.mjs";
import { pathExists } from "./staging-lib.mjs";
import {
  SharedTargetConflictAbort, applyManagedFiles, managedFilesInstalled, managedFilesRemnants, removeManagedFiles,
} from "./managed-files-row.mjs";
import { fragmentHooks } from "../harnesses/hook-readiness.mjs";

export const SHARED_TARGET_KINDS = Object.freeze(["hook_fragment", "managed_files"]);

export { SharedTargetConflictAbort };

export function applySharedTargetRow(row, { onConflict = "keep", dryRun = false } = {}) {
  if (row.kind === "hook_fragment") return applyHookFragment(row, { dryRun });
  if (row.kind === "managed_files") return applyManagedFiles(row, { onConflict, dryRun });
  throw new Error(`not a shared-target row kind: ${row.kind}`);
}

export function removeSharedTargetRow(row, { dryRun = false } = {}) {
  if (row.kind === "hook_fragment") return removeHookFragment(row, { dryRun });
  if (row.kind === "managed_files") return removeManagedFiles(row, { dryRun });
  throw new Error(`not a shared-target row kind: ${row.kind}`);
}

// Whether every entry of this row is in place, as `bundle apply`'s applied check asks of each row.
export function sharedTargetInstalled(row) {
  if (row.kind === "hook_fragment") return installedFragmentHooks(row).length === fragmentHooks(sourceFragment(row)).length;
  return managedFilesInstalled(row);
}

// Paths or hook commands of this row that are still installed; uninstall's remnant check uses it.
export function sharedTargetRemnants(row) {
  if (row.kind === "hook_fragment") {
    return installedFragmentHooks(row).map((hook) => `${row.homeAbs} ${hook.event}: ${hook.command}`);
  }
  return managedFilesRemnants(row);
}

function installedFragmentHooks(row) {
  const installed = new Set(fragmentHooks(readHooksMap(row.homeAbs)).map(hookKey));
  return fragmentHooks(sourceFragment(row)).filter((hook) => installed.has(hookKey(hook)));
}

function hookKey(hook) {
  return `${hook.event}\t${hook.command}`;
}

function applyHookFragment(row, { dryRun }) {
  const fragment = sourceFragment(row);
  mergeHooksInto(row.harness, row.homeAbs, fragment, { dryRun });
}

function removeHookFragment(row, { dryRun }) {
  if (!pathExists(row.homeAbs)) return;
  unmergeHooksFrom(row.harness, row.homeAbs, sourceFragment(row), { dryRun });
  if (dryRun) return;
  // A hooks file left holding nothing but an empty map was RoboRepo's to begin with.
  const parsed = readJson(row.homeAbs);
  if (parsed && Object.keys(parsed).length === 1 && Object.keys(parsed.hooks || {}).length === 0) {
    fs.rmSync(row.homeAbs);
    console.log(`remove: ${row.homeAbs} (no hooks left)`);
  }
}

function sourceFragment(row) {
  return readJson(path.join(repoRoot, row.srcRel))?.hooks ?? {};
}

function readHooksMap(filePath) {
  return readJson(filePath)?.hooks ?? {};
}

function readJson(filePath) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return null; }
}

// node shared-target-rows.mjs apply|remove|remnants <kind> <harness> <src_rel> <home_abs> [--dry-run]
// The conflict policy comes from ROBOREPO_ON_CONFLICT, which the bash installer already exports.
if (isMainModule(import.meta.url)) {
  const [command, kind, harness, srcRel, homeAbs] = process.argv.slice(2);
  const dryRun = process.argv.includes("--dry-run");
  const row = { kind, harness, srcRel, homeAbs };
  if (!SHARED_TARGET_KINDS.includes(kind) || !harness || !srcRel || !homeAbs) {
    console.error("usage: node shared-target-rows.mjs apply|remove|remnants <hook_fragment|managed_files> <harness> <src_rel> <home_abs> [--dry-run]");
    process.exit(2);
  }
  try {
    if (command === "apply") applySharedTargetRow(row, { onConflict: process.env.ROBOREPO_ON_CONFLICT || "keep", dryRun });
    else if (command === "remove") removeSharedTargetRow(row, { dryRun });
    else if (command === "remnants") for (const remnant of sharedTargetRemnants(row)) console.log(remnant);
    else throw new Error(`unknown command: ${command}`);
  } catch (error) {
    console.error(error instanceof SharedTargetConflictAbort ? `abort: ${error.message}` : error?.message || String(error));
    process.exit(1);
  }
}
