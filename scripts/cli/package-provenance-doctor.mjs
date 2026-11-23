#!/usr/bin/env node
// `doctor --installed` checks for package provenance: the source list is readable, every path
// source's folder exists, the lock is readable, no package ID is claimed by two sources without a
// choice, every recorded package still resolves from the source it was recorded from, and live
// packages have not changed since RoboRepo last applied them.
//
// Prints one line per finding: `fail: ...` for a problem that leaves a package unusable or its
// origin unknown, `hint: ...` for something worth knowing that is not broken (a local package
// edited since it was applied, bare-ID state not yet migrated). Exits 1 when any finding fails.
import fs from "node:fs";
import { isMainModule } from "./roots.mjs";
import { readSourceConfig, sourceDirectory } from "./package-sources.mjs";
import { readPackageLock } from "./package-lock.mjs";
import { collisionMessage, composePackageCatalog } from "./package-catalog.mjs";
import { hashPackageTree } from "./package-install-store.mjs";
import { needsProvenanceMigration } from "./package-provenance-migration.mjs";
import { readAppliedRecord } from "./package-state.mjs";

export function packageProvenanceFindings() {
  const findings = [];
  const fail = (message) => findings.push({ level: "fail", message });
  const hint = (message) => findings.push({ level: "hint", message });

  let sources;
  try {
    sources = readSourceConfig().sources;
  } catch (err) {
    fail(err.message);
    return findings;
  }
  for (const record of sources) {
    if (!record.enabled || record.type !== "path") continue;
    const dir = sourceDirectory(record);
    // The workspace folder appears on first use, so only a configured folder must exist.
    if (!record.workspace && !fs.existsSync(dir)) fail(`package source ${record.id}: folder does not exist: ${dir}`);
  }

  let lock;
  try {
    lock = readPackageLock();
  } catch (err) {
    fail(err.message);
    return findings;
  }

  let composed;
  try {
    composed = composePackageCatalog({ sources, lock });
  } catch (err) {
    fail(`package catalog: ${err.message}`);
    return findings;
  }
  for (const collision of composed.collisions) fail(collisionMessage(collision));
  for (const entry of composed.unresolved) {
    fail(`package ${entry.id} is unresolved: ${entry.reason}. Reinstall it with \`roborepo package install <source>/${entry.id}\` or remove it with \`roborepo package remove ${entry.id}\``);
  }

  const applied = readAppliedRecord();
  const resolvedIds = new Set(composed.packages.map((pkg) => pkg.id));
  const unrecorded = applied.packages.filter((id) => resolvedIds.has(id) && !lock.packages[id]);
  if (needsProvenanceMigration(undefined, applied)) {
    hint("package state predates package sources; the next package enable, disable, or reconcile records each package's source");
  } else if (unrecorded.length > 0) {
    hint(`applied without a lock record: ${unrecorded.join(", ")}; the next \`roborepo package reconcile\` records them`);
  }

  for (const record of Object.values(lock.packages)) {
    if (record.kind !== "live" || !record.fingerprint) continue;
    if (!fs.existsSync(record.resolved)) continue; // reported as unresolved above when it matters
    if (hashPackageTree(record.resolved) !== record.fingerprint) {
      hint(`package ${record.sourceId}/${record.packageId} changed since it was applied; run \`roborepo package reconcile\` to apply the edits`);
    }
  }
  return findings;
}

if (isMainModule(import.meta.url)) {
  const findings = packageProvenanceFindings();
  for (const { level, message } of findings) console.log(`${level}: ${message}`);
  process.exit(findings.some((finding) => finding.level === "fail") ? 1 : 0);
}
