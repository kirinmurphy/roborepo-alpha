import fs from "node:fs";
import path from "node:path";
import { harnessHome } from "./paths.mjs";
import { writeRootConfig } from "./root-config-writes.mjs";
import { detachRepoLink, resolvesIntoRepo } from "./repo-links.mjs";
import { recordConfigWrite } from "./write-log.mjs";
import { getHarnessProvider } from "../harnesses/registry.mjs";
import { hasHarnessPath, resolveHarnessPath } from "../harnesses/paths.mjs";
import { validateAdapterComputeResult } from "../harnesses/schemas.mjs";

// Cross-harness hook merge/unmerge. Both Claude (~/.claude/settings.json, hooks nested under a
// `hooks` key alongside permissions/etc.) and Codex (~/.codex/hooks.json, a dedicated file whose
// whole content is `{ hooks: {...} }`) use the same per-event entry shape:
//   { event: [ { matcher, hooks: [ { type: "command", command } ] } ] }
// Identity is the literal `command` string (matches the pre-existing Claude-only mergeHooks in
// packages.mjs) — no package-ID tag is stored on the entry itself. This keeps the merge/unmerge
// logic byte-for-byte compatible with hooks installed before this module existed.
//
// The actual merge/unmerge math lives behind each provider's hooks.merge/hooks.unmerge adapter
// (scripts/harnesses/{claude,codex}/index.mjs, wrapping scripts/harnesses/hooks-merge.mjs's pure
// logic) — this module now only resolves the target file path, dispatches to the provider, and
// performs the write. Claude's write goes through writeRootConfig for drift-tracking (settings.json
// is the root config); Codex's hooks.json has no root-config equivalent, so it's a plain file write.
export function writeHooksFile(harness, filePath, content) {
  const provider = getHarnessProvider(harness);
  if (hasHarnessPath(provider.manifest, "hooks")) {
    detachRepoLink(filePath);
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, content);
    recordConfigWrite(filePath);
    return;
  }
  writeRootConfig(harness, filePath, content);
}

// A provider with a dedicated hooks path uses it; otherwise hooks live in its root config.
// The optional rootConfigPath lets callers supply the active or fixture root-config location.
export function hookFilePath(harness, { rootConfigPath } = {}) {
  const provider = getHarnessProvider(harness); // throws for an unrecognized id
  if (hasHarnessPath(provider.manifest, "hooks")) return resolveHarnessPath(provider.manifest, "hooks");
  return rootConfigPath ?? resolveHarnessPath(provider.manifest, "rootConfig");
}

export function mergeHooksInto(harness, filePath, hooksFragment, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`  [dry-run] merge hooks (${harness}) → ${filePath}`);
    return;
  }
  const result = getHarnessProvider(harness).adapters.hooks.merge(filePath, hooksFragment);
  validateAdapterComputeResult(result);
  const { changed, content } = result;
  if (changed) {
    writeHooksFile(harness, filePath, content);
    console.log(`wired: hook entries (${harness}) → ${filePath}`);
  } else {
    console.log(`ok: hooks already present (${harness}) → ${filePath}`);
  }
}

// Some hook fragments reference a command that runs a script this repo owns (e.g.
// "$HOME/.claude/hooks/block-source-exploration.mjs"). Merging the JSON fragment only wires the
// string reference — the script file itself must be copied into the harness's hooks dir
// separately, since (unlike the system hooks/ directory) package-owned hook scripts are not part of
// any unconditional manifest copy.
export function installHookScripts(harness, scriptRepoRelPaths, repoRoot, { dryRun = false } = {}) {
  const destDir = path.join(harnessHome[harness], "hooks");
  if (!dryRun && resolvesIntoRepo(destDir, repoRoot)) {
    console.error(`  refusing to install hook scripts: ${destDir} resolves into the repo tree (stale legacy symlink?)`);
    return;
  }
  for (const relPath of scriptRepoRelPaths) {
    const src = path.join(repoRoot, relPath);
    const dest = path.join(destDir, path.basename(relPath));
    if (dryRun) {
      console.log(`  [dry-run] install hook script ${relPath} → ${dest}`);
      continue;
    }
    fs.mkdirSync(destDir, { recursive: true });
    fs.copyFileSync(src, dest);
    console.log(`copied: ${dest} ← ${relPath}`);
  }
}

export function removeHookScripts(harness, scriptRepoRelPaths, repoRoot, { dryRun = false } = {}) {
  const destDir = path.join(harnessHome[harness], "hooks");
  if (!dryRun && resolvesIntoRepo(destDir, repoRoot)) {
    console.error(`  refusing to remove hook scripts: ${destDir} resolves into the repo tree (stale legacy symlink?)`);
    return;
  }
  for (const relPath of scriptRepoRelPaths) {
    const dest = path.join(destDir, path.basename(relPath));
    if (dryRun) {
      console.log(`  [dry-run] remove hook script ${dest}`);
      continue;
    }
    if (fs.existsSync(dest)) {
      fs.rmSync(dest);
      console.log(`removed: ${dest}`);
    }
  }
}

export function unmergeHooksFrom(harness, filePath, hooksFragment, { dryRun = false } = {}) {
  if (dryRun) {
    console.log(`  [dry-run] remove hooks (${harness}) ← ${filePath}`);
    return;
  }
  const result = getHarnessProvider(harness).adapters.hooks.unmerge(filePath, hooksFragment);
  validateAdapterComputeResult(result);
  const { changed, content } = result;
  if (changed) {
    writeHooksFile(harness, filePath, content);
    console.log(`removed: hook entries (${harness}) ← ${filePath}`);
  } else {
    console.log(`ok: hooks already absent (${harness}) ← ${filePath}`);
  }
}
