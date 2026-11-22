#!/usr/bin/env node
// Whether the harness config installed in the user's home is behind what this checkout installs:
// the parts `roborepo update` would change if it ran now. Read-only, offline, and limited to what
// RoboRepo owns, so a rule or file the user added never counts.
//
// What it compares, per harness home RoboRepo has installed into (MANAGED_BY_ROBOREPO.md present):
//   - The permissions file. `roborepo update` re-renders it through the provider's permissions
//     adapter; this renders the same thing in memory from the installed file. For a JSON root config
//     (Claude's settings.json) only the owned parts count: permission rules the provider's
//     `managedRules` names, the `sandbox` key, and hook entries the render adds. A text file the
//     render owns whole (Gemini's policy file) counts on any difference.
//   - Files install copies from the repo (manifest.tsv `managed_copy` and `managed_files` rows),
//     where the installed copy exists and differs from its source. Files packages add beside them
//     are never listed by the manifest, so they are never compared.
//   - Hook entries a `hook_fragment` row merges into a hooks file, once any of them is installed.
//
// Not compared: a provider whose permission render depends on the folder update ran from (Codex
// widens its sandbox for that repo's workspace roots), managed files not installed at all (optional
// bundles leave them out on purpose), and rendered rules files (rules-render.mjs --check owns those).

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { repoRoot, harnessHome } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { commandOverridesPath, managedFilesStatePath, readJsonState } from "./state-paths.mjs";
import { hashFile } from "./root-config-state.mjs";
import { loadPermissionManifest, previewPermissionRenders } from "./permissions-render.mjs";
import { fragmentHooks } from "../harnesses/hook-readiness.mjs";

const MARKER = "MANAGED_BY_ROBOREPO.md";

// Same shape and fallback as readCommandOverrides in config-mutate.mjs, read here directly because
// that module loads the whole package engine and doctor runs on every call.
function readOverrides() {
  try {
    const raw = JSON.parse(fs.readFileSync(commandOverridesPath, "utf8"));
    return {
      behaviors: raw.behaviors && typeof raw.behaviors === "object" ? raw.behaviors : {},
      commands: raw.commands && typeof raw.commands === "object" ? raw.commands : {},
    };
  } catch {
    return { behaviors: {}, commands: {} };
  }
}

function readManifestRows(root) {
  const text = fs.readFileSync(path.join(root, "manifests", "platform", "manifest.tsv"), "utf8");
  const rows = [];
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim() || line.startsWith("#")) continue;
    const [harness, kind, srcRel, homeSub, , flags = "-"] = line.split("\t");
    if (!harnessHome[harness] || !kind || !homeSub) continue;
    // `nodoctor` rows (the MANAGED_BY_ROBOREPO.md marker) are outside doctor's installed checks.
    if (flags.split(",").includes("nodoctor")) continue;
    rows.push({ harness, kind, srcRel, homeSub, homeAbs: path.join(harnessHome[harness], homeSub) });
  }
  return rows;
}

function installedHarnesses() {
  return new Set(Object.entries(harnessHome)
    .filter(([, home]) => home && fs.existsSync(path.join(home, MARKER)))
    .map(([id]) => id));
}

function readJson(text) {
  try { return JSON.parse(text); } catch { return null; }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return null; }
}

function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value ?? null);
}

const hookKey = (hook) => `${hook.event}\t${hook.command}`;

function missingHooks(wantedMap, installedMap) {
  const installed = new Set(fragmentHooks(installedMap).map(hookKey));
  return fragmentHooks(wantedMap).filter((hook) => !installed.has(hookKey(hook)));
}

// The owned parts of a JSON root config whose render replaces `permissions` lists.
function jsonConfigDrift(preview, overrides, manifest) {
  const installed = readJson(preview.current);
  const rendered = readJson(preview.render());
  if (!installed || !rendered) return [];
  const managedRules = preview.provider.adapters.permissions.managedRules?.(manifest, overrides) ?? new Set();
  const added = [];
  const removed = [];
  for (const bucket of ["allow", "deny", "ask"]) {
    const want = new Set(rendered.permissions?.[bucket] ?? []);
    const have = new Set(installed.permissions?.[bucket] ?? []);
    for (const rule of want) if (!have.has(rule)) added.push(`${bucket} ${rule}`);
    for (const rule of have) if (!want.has(rule) && managedRules.has(rule)) removed.push(`${bucket} ${rule}`);
  }
  const items = [];
  const base = { harness: preview.provider.id, file: preview.file };
  if (added.length || removed.length) {
    const rules = new Set([...added, ...removed].map((entry) => entry.slice(entry.indexOf(" ") + 1)));
    items.push({ ...base, kind: "permission-rules", count: rules.size, added, removed });
  }
  if ("sandbox" in rendered && canonical(rendered.sandbox) !== canonical(installed.sandbox)) {
    items.push({ ...base, kind: "sandbox", count: 1 });
  }
  const hooks = missingHooks(rendered.hooks, installed.hooks);
  if (hooks.length) items.push({ ...base, kind: "hook-entries", count: hooks.length, hooks });
  return items;
}

function permissionDrift(installed, home) {
  const manifest = loadPermissionManifest();
  const overrides = readOverrides();
  const items = [];
  const skipped = [];
  const renderedFiles = new Set();
  for (const preview of previewPermissionRenders(home, { manifest, overrides })) {
    if (!installed.has(preview.provider.id)) continue;
    renderedFiles.add(preview.file);
    if (preview.cwdDependent) {
      skipped.push(preview.provider.id);
      continue;
    }
    if (preview.provider.manifest.extensions?.app?.rootConfigFormat === "json" && preview.file.endsWith(".json")) {
      items.push(...jsonConfigDrift(preview, overrides, manifest));
    } else if (preview.render() !== preview.current) {
      items.push({ harness: preview.provider.id, file: preview.file, kind: "permission-file", count: 1 });
    }
  }
  return { items, skipped, renderedFiles };
}

function sourceFiles(root, row) {
  const sourceRoot = path.join(root, row.srcRel);
  if (!fs.existsSync(sourceRoot)) return [];
  if (!fs.statSync(sourceRoot).isDirectory()) return [{ source: sourceRoot, target: row.homeAbs }];
  return fs.readdirSync(sourceRoot, { recursive: true, withFileTypes: true })
    .filter((entry) => entry.isFile())
    .map((entry) => {
      const source = path.join(entry.parentPath ?? entry.path, entry.name);
      return { source, target: path.join(row.homeAbs, path.relative(sourceRoot, source)) };
    });
}

function isRegularFile(target) {
  try { return fs.lstatSync(target).isFile(); } catch { return false; }
}

function fileDrift(root, rows, installed, renderedFiles) {
  const recorded = readJsonState(managedFilesStatePath, {});
  const items = [];
  for (const row of rows) {
    if (!installed.has(row.harness)) continue;
    if (row.kind === "managed_copy" || row.kind === "managed_files") {
      for (const { source, target } of sourceFiles(root, row)) {
        // The permission render writes after install and wins (Gemini's policy file); compared above.
        if (renderedFiles.has(target) || !isRegularFile(target)) continue;
        const current = hashFile(target);
        if (current === hashFile(source)) continue;
        // A managed_files copy whose hash no longer matches what RoboRepo recorded was edited by
        // hand, and update keeps it rather than overwrite the edit.
        const edited = row.kind === "managed_files" && recorded[target] !== undefined && recorded[target] !== current;
        items.push({
          harness: row.harness, kind: /(^|\/)(git-)?hooks(\/|$)/.test(row.homeSub) ? "hook-file" : "file",
          file: target, source: path.relative(root, source), edited, count: 1,
        });
      }
    }
    if (row.kind === "hook_fragment" && fs.existsSync(row.homeAbs)) {
      const wanted = readJsonFile(path.join(root, row.srcRel))?.hooks ?? {};
      const installedMap = readJsonFile(row.homeAbs)?.hooks ?? {};
      const missing = missingHooks(wanted, installedMap);
      // None installed means the optional bundle that carries them is off, not that it is stale.
      if (missing.length && missing.length < fragmentHooks(wanted).length) {
        items.push({ harness: row.harness, kind: "hook-entries", file: row.homeAbs, count: missing.length, hooks: missing });
      }
    }
  }
  return items;
}

export function findInstallDrift() {
  const installed = installedHarnesses();
  if (installed.size === 0) return { items: [], skipped: [] };
  const { items, skipped, renderedFiles } = permissionDrift(installed, os.homedir());
  items.push(...fileDrift(repoRoot, readManifestRows(repoRoot), installed, renderedFiles));
  return { items, skipped };
}

const NOUNS = {
  "permission-rules": ["permission rule", "permission rules"],
  "permission-file": ["permission policy file", "permission policy files"],
  sandbox: ["sandbox setting block", "sandbox setting blocks"],
  "hook-entries": ["hook entry", "hook entries"],
  "hook-file": ["hook file", "hook files"],
  file: ["managed file", "managed files"],
};

function counted(kind, count) {
  const [one, many] = NOUNS[kind];
  return `${count} ${count === 1 ? one : many}`;
}

function joinList(parts) {
  return parts.length <= 1 ? parts.join("") : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

const tilde = (file) => {
  const home = os.homedir();
  return file === home || file.startsWith(`${home}${path.sep}`) ? `~${file.slice(home.length)}` : file;
};

// One summary sentence plus one indented line per difference. The caller adds the doctor prefix.
export function describeInstallDrift(items) {
  const totals = new Map();
  for (const item of items) totals.set(item.kind, (totals.get(item.kind) ?? 0) + item.count);
  const summary = joinList([...totals].map(([kind, count]) => counted(kind, count)));
  const details = [];
  for (const item of items) {
    const where = `${item.harness}: ${tilde(item.file)}`;
    if (item.kind === "permission-rules") {
      for (const entry of item.removed) details.push(`${where} still has ${entry}, which this checkout no longer installs`);
      for (const entry of item.added) details.push(`${where} is missing ${entry}`);
    } else if (item.kind === "hook-entries") {
      for (const hook of item.hooks) details.push(`${where} is missing the ${hook.event} hook \`${hook.command}\``);
    } else if (item.kind === "sandbox") {
      details.push(`${where} has an older sandbox setting block`);
    } else if (item.kind === "permission-file") {
      details.push(`${where} differs from the permission rules this checkout renders`);
    } else if (item.edited) {
      details.push(`${tilde(item.file)} was edited by hand and differs from ${item.source}; update keeps your copy, so delete it first to take the new one`);
    } else {
      details.push(`${tilde(item.file)} differs from ${item.source}`);
    }
  }
  return { summary, details };
}

// node install-drift.mjs --check   exit 0 and print nothing when current; exit 1 and print the
// summary on line 1 and the details after it when the install is behind.
if (isMainModule(import.meta.url)) {
  const { items } = findInstallDrift();
  if (items.length === 0) process.exit(0);
  const { summary, details } = describeInstallDrift(items);
  console.log(summary);
  for (const line of details) console.log(`  ${line}`);
  process.exit(1);
}
