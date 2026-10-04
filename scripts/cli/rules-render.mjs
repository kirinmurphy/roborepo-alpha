import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";
import { enabledPackagesPath, stateDir } from "./state-paths.mjs";
import { loadPackageCatalog } from "./package-catalog.mjs";
import { listHarnessProviders, getHarnessProvider } from "../harnesses/registry.mjs";
import { resolveHarnessPath, hasHarnessPath } from "../harnesses/paths.mjs";

// Rule fragment source directories per harness, in render order. "shared" (harness-agnostic) is
// always first; each provider's own fragments live at globals/system/rules/<id> — a uniform,
// convention-derived location from the provider's own id, not manifest data, since every provider
// follows the same globals/<resource>/<id>/ shape (see globals/harnesses/<id>/ for the analogous
// per-provider metadata directory).
export function ruleDirsFor(providerId) {
  return ["globals/system/rules/shared", `globals/system/rules/${providerId}`];
}

export function knownHarnessIds() {
  return listHarnessProviders().map((provider) => provider.id);
}

// Harness ids that declare a given capability. Use this instead of a literal id list anywhere a
// resource is being targeted at "the harnesses that support X" — a new provider then opts in by
// declaring the capability in its manifest, with no edit to the calling site. Returns ids in
// registry order so generated output (manifests, scaffolds) stays stable.
export function harnessIdsWithCapability(capability) {
  return listHarnessProviders()
    .filter((provider) => provider.manifest.capabilities.includes(capability))
    .map((provider) => provider.id);
}

// Live home rules file path for a harness — the provider manifest's "rules" path
// (~/.claude/CLAUDE.md, ~/.codex/AGENTS.md), resolved through the shared harness-path resolver
// so nothing outside a provider hardcodes ~/.claude or ~/.codex.
function homeRulesPath(harness) {
  return resolveHarnessPath(getHarnessProvider(harness).manifest, "rules");
}

// Marker that distinguishes roborepo render output from user-authored content.
const RENDER_HEADER = "# Generated Harness Rules";
const CODE_STYLE_BLOCK = "builtin-code-style";
// Legacy Claude wrapper marker. Kept so updates/uninstalls can replace old import blocks safely.
const AGENTS_IMPORT_BLOCK = "managed-agents-import";
const LEGACY_GENERATED_RULES_FILE = path.join(stateDir, "rules", "generated-rules.md");

// --------------------------------------------------------------------------- registry

// Returns { exists: boolean, packages: string[], disabled: string[] }. `packages` is the explicit-
// enable list; `disabled` is the explicit-disable list (only meaningful for default-enabled
// packages, since an explicit disable of a non-default package is just absence from `packages`).
// `exists` distinguishes "no registry yet" (pre-Phase-3, fall back to text scan in config.mjs) from
// "registry exists but empty".
export function readEnabledPackagesRegistry() {
  try {
    const data = JSON.parse(fs.readFileSync(enabledPackagesPath, "utf8"));
    return {
      exists: true,
      packages: Array.isArray(data.packages) ? data.packages : [],
      disabled: Array.isArray(data.disabled) ? data.disabled : [],
    };
  } catch {
    return { exists: false, packages: [], disabled: [] };
  }
}

function writeRegistry(ids, disabledIds) {
  fs.mkdirSync(path.dirname(enabledPackagesPath), { recursive: true });
  fs.writeFileSync(enabledPackagesPath, JSON.stringify(
    { packages: [...new Set(ids)], disabled: [...new Set(disabledIds)], updatedAt: new Date().toISOString() },
    null, 2,
  ) + "\n");
}

// Add or remove a package ID from the enabled-packages registry, then return the updated list.
// Explicit-disable precedence: enabling clears any prior explicit-disable; disabling clears any
// prior explicit-enable and records an explicit-disable (load-bearing only for default-enabled
// packages — see effectiveEnabledIds — but recorded unconditionally so a package that later
// becomes default-enabled doesn't silently re-enable itself for someone who turned it off).
export function setPackageEnabled(id, enabled) {
  const { packages, disabled } = readEnabledPackagesRegistry();
  const next = enabled
    ? [...new Set([...packages, id])]
    : packages.filter((x) => x !== id);
  const nextDisabled = enabled
    ? disabled.filter((x) => x !== id)
    : [...new Set([...disabled, id])];
  writeRegistry(next, nextDisabled);
  return next;
}

// Drop package IDs from both registry lists. Used for IDs the catalog no longer contains (a
// retired or renamed package): an explicit disable of a package that does not exist protects
// nothing, and parking the ID in `disabled` would keep it in the registry forever.
export function forgetPackageIds(ids) {
  const drop = new Set(ids);
  if (drop.size === 0) return;
  const { packages, disabled } = readEnabledPackagesRegistry();
  writeRegistry(packages.filter((id) => !drop.has(id)), disabled.filter((id) => !drop.has(id)));
}

// Effective enabled-ID set for a catalog: explicit-enable OR (default-enabled AND NOT explicit-
// disable). This is the "should this package's behavior be live" answer — use it anywhere that
// needs to know what's actually active (rendering, probing, ownership/conflict checks,
// reconciliation). Precedence: explicit-disable > explicit-enable > current defaults.
export function effectiveEnabledIds(catalog, registry = readEnabledPackagesRegistry()) {
  const explicit = new Set(registry.packages || []);
  const explicitOff = new Set(registry.disabled || []);
  const out = new Set();
  for (const id of explicit) if (!explicitOff.has(id)) out.add(id);
  for (const pkg of catalog) {
    if (pkg.defaultEnabled && !explicitOff.has(pkg.id)) out.add(pkg.id);
  }
  return [...out];
}

// --------------------------------------------------------------------------- render

function squashBlankLines(text) {
  return text.replace(/\n{3,}/g, "\n\n");
}

// True when the file is a roborepo render output (not user-authored content). Used by install/
// uninstall to tell roborepo-owned files from genuine user files.
export function isRenderedRulesOutput(filePath) {
  try {
    const stat = fs.lstatSync(filePath);
    if (stat.isSymbolicLink()) return false;
    const text = fs.readFileSync(filePath, "utf8");
    return text.startsWith(RENDER_HEADER) || hasCompleteManagedBlock(text, CODE_STYLE_BLOCK) || hasCompleteManagedBlock(text, AGENTS_IMPORT_BLOCK);
  } catch {
    return false;
  }
}

function renderContent(harness, enabledIds) {
  const catalog = loadPackageCatalog();
  const parts = [];

  // Header matches render-rules.sh so the format is recognizable.
  parts.push(RENDER_HEADER);
  parts.push("");
  parts.push("Generated from `globals/system/rules/shared/` and harness-specific `globals/system/rules/<harness>/` fragments.");
  parts.push("Enabled packages are appended. Run `roborepo update` to refresh.");
  parts.push("");

  for (const dir of ruleDirsFor(harness)) {
    const absDir = path.join(repoRoot, dir);
    if (!fs.existsSync(absDir)) continue;
    for (const file of fs.readdirSync(absDir).filter((f) => f.endsWith(".md")).sort()) {
      const content = fs.readFileSync(path.join(absDir, file), "utf8");
      parts.push("");
      parts.push(squashBlankLines(content).trimEnd());
      parts.push("");
    }
  }

  for (const pkg of catalog) {
    if (!enabledIds.includes(pkg.id)) continue;
    for (const comp of pkg.components) {
      if (comp.type !== "rules") continue;
      if (comp.harness !== "both" && comp.harness !== harness) continue;
      const content = fs.readFileSync(path.join(repoRoot, comp.source), "utf8");
      parts.push("");
      parts.push(squashBlankLines(content).trimEnd());
      parts.push("");
    }
  }

  return squashBlankLines(parts.join("\n")).trimEnd() + "\n";
}

// Read-only preview helpers for the /config web page. Render the same fragments renderContent uses,
// but return the text instead of writing it. enabledIds defaults to the live registry so the preview
// matches what's actually rendered into the home rules.
function readFragmentDir(dir) {
  const absDir = path.join(repoRoot, dir);
  if (!fs.existsSync(absDir)) return "";
  const parts = [];
  for (const file of fs.readdirSync(absDir).filter((f) => f.endsWith(".md")).sort()) {
    parts.push(squashBlankLines(fs.readFileSync(path.join(absDir, file), "utf8")).trimEnd());
  }
  return parts.join("\n\n");
}

// Full rendered home-rules text for one harness (shared + harness fragments + enabled package rules).
export function renderRulesPreview(harness, enabledIds = effectiveEnabledIds(loadPackageCatalog())) {
  return renderContent(harness, enabledIds);
}

// Just the harness-agnostic shared fragments (globals/system/rules/shared), no harness-specific rules or
// package rules — the "Globals" section shows this as the baseline every harness gets.
export function renderSharedRulesPreview() {
  return readFragmentDir("globals/system/rules/shared");
}

// Just one harness's harness-specific fragments (globals/system/rules/<harness>), excluding shared.
export function renderHarnessRulesPreview(harness) {
  if (!knownHarnessIds().includes(harness)) return "";
  return readFragmentDir(`globals/system/rules/${harness}`);
}

export function renderEnabledPackageRulesPreview(enabledIds) {
  const catalog = loadPackageCatalog();
  if (enabledIds === undefined) enabledIds = effectiveEnabledIds(catalog);
  const parts = [];
  for (const pkg of catalog) {
    if (!enabledIds.includes(pkg.id)) continue;
    for (const comp of pkg.components) {
      if (comp.type !== "rules") continue;
      const content = fs.readFileSync(path.join(repoRoot, comp.source), "utf8").trimEnd();
      parts.push(`## ${pkg.label} (${pkg.id})\n\n${content}`);
    }
  }
  return squashBlankLines(parts.join("\n\n")).trimEnd();
}

function beginMarker(name) {
  return `<!-- BEGIN managed:${name} -->`;
}

function endMarker(name) {
  return `<!-- END managed:${name} -->`;
}

function markerCounts(text, name) {
  const begin = beginMarker(name);
  const end = endMarker(name);
  return {
    begin,
    end,
    begins: text.split(begin).length - 1,
    ends: text.split(end).length - 1,
  };
}

function hasCompleteManagedBlock(text, name) {
  const counts = markerCounts(text, name);
  if (counts.begins !== 1 || counts.ends !== 1) return false;
  const beginAt = text.indexOf(counts.begin);
  const endAt = text.indexOf(counts.end);
  return beginAt >= 0 && endAt > beginAt;
}

function assertManageableBlock(text, name, filePath) {
  const counts = markerCounts(text, name);
  if (counts.begins === 0 && counts.ends === 0) return counts;
  if (counts.begins === 1 && counts.ends === 1 && text.indexOf(counts.end) > text.indexOf(counts.begin)) return counts;
  throw new Error([
    `Found an incomplete Roborepo managed block in ${path.basename(filePath)}.`,
    "",
    "I cannot safely determine which content is Roborepo-owned and which content is user-owned.",
    "",
    "Please edit the file manually, then rerun the installer.",
  ].join("\n"));
}

function blockText(name, content) {
  return `${beginMarker(name)}\n${content.trimEnd()}\n${endMarker(name)}\n`;
}

function replaceManagedBlockText(existing, name, content, filePath) {
  const counts = assertManageableBlock(existing, name, filePath);
  const nextBlock = blockText(name, content);
  if (counts.begins === 0) {
    const rest = existing.replace(/^\n+/, "");
    return rest.trim().length > 0 ? `${nextBlock}\n${rest}` : nextBlock;
  }
  const start = existing.indexOf(counts.begin);
  const end = existing.indexOf(counts.end, start);
  let after = end + counts.end.length;
  if (existing[after] === "\r" && existing[after + 1] === "\n") after += 2;
  else if (existing[after] === "\n") after += 1;
  return `${existing.slice(0, start)}${nextBlock}${existing.slice(after)}`.replace(/\n{3,}/g, "\n\n");
}

function removeManagedBlockText(existing, name, filePath) {
  const counts = assertManageableBlock(existing, name, filePath);
  if (counts.begins === 0) return existing;
  const start = existing.indexOf(counts.begin);
  const end = existing.indexOf(counts.end, start);
  let after = end + counts.end.length;
  if (existing[after] === "\r" && existing[after + 1] === "\n") after += 2;
  else if (existing[after] === "\n") after += 1;
  return `${existing.slice(0, start)}${existing.slice(after)}`.replace(/^\n+/, "").replace(/\n{3,}/g, "\n\n");
}

function readText(filePath) {
  try {
    return fs.readFileSync(filePath, "utf8");
  } catch {
    return "";
  }
}

function writeText(filePath, text, dryRun, label = "write") {
  if (dryRun) {
    console.log(`[dry-run] would ${label}: ${filePath}`);
    return;
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, text);
  console.log(`${label}: ${filePath}`);
}

function writeManagedBlock(filePath, name, content, dryRun) {
  const next = replaceManagedBlockText(readText(filePath), name, content, filePath);
  writeText(filePath, next, dryRun, "render");
}

function writeRulesBlock(filePath, content, dryRun) {
  const withoutLegacyImport = removeManagedBlockText(readText(filePath), AGENTS_IMPORT_BLOCK, filePath);
  const next = replaceManagedBlockText(withoutLegacyImport, CODE_STYLE_BLOCK, content, filePath);
  writeText(filePath, next, dryRun, "render");
}

function removeLegacyClaudeRulesFile(dryRun) {
  if (!fs.existsSync(LEGACY_GENERATED_RULES_FILE)) return;
  if (!readText(LEGACY_GENERATED_RULES_FILE).startsWith(RENDER_HEADER)) return;
  if (dryRun) {
    console.log(`[dry-run] would remove legacy rules file: ${LEGACY_GENERATED_RULES_FILE}`);
    return;
  }
  fs.unlinkSync(LEGACY_GENERATED_RULES_FILE);
  console.log(`remove legacy rules file: ${LEGACY_GENERATED_RULES_FILE}`);
}

function removeManagedBlock(filePath, name, dryRun) {
  if (!fs.existsSync(filePath)) return;
  const current = readText(filePath);
  const next = removeManagedBlockText(current, name, filePath);
  if (next === current) return;
  if (next.trim().length === 0) {
    if (dryRun) {
      console.log(`[dry-run] would remove: ${filePath}`);
      return;
    }
    fs.unlinkSync(filePath);
    console.log(`remove: ${filePath}`);
    return;
  }
  writeText(filePath, next, dryRun, "remove managed block");
}

function removeManagedBlocks(filePath, names, dryRun) {
  if (!fs.existsSync(filePath)) return;
  const current = readText(filePath);
  const next = names.reduce(
    (text, name) => removeManagedBlockText(text, name, filePath),
    current,
  );
  if (next === current) return;
  if (next.trim().length === 0) {
    if (dryRun) {
      console.log(`[dry-run] would remove: ${filePath}`);
      return;
    }
    fs.unlinkSync(filePath);
    console.log(`remove: ${filePath}`);
    return;
  }
  writeText(filePath, next, dryRun, "remove managed block");
}

// Write rendered home rules for one or all harnesses:
//   - Unlinks any legacy symlink into the repo first.
//   - Writes rules inline inside managed blocks.
//   - Mirrors into a provider's declared "rulesOverride" path too, when that path exists on disk
//     and the provider declares one (currently Codex's AGENTS.override.md; a provider that doesn't
//     declare "rulesOverride" — e.g. Claude — is skipped entirely, no per-harness branch needed).
// Skips harnesses whose home dir does not exist (harness not installed on this machine).
export function renderHomeRules({ dryRun = false, harness: targetHarness } = {}) {
  const registry = readEnabledPackagesRegistry();
  if (!registry.exists && !dryRun) writeRegistry([], []);
  const enabledIds = effectiveEnabledIds(loadPackageCatalog(), registry);
  const harnesses = targetHarness ? [targetHarness] : knownHarnessIds();

  for (const harness of harnesses) {
    const homeFile = homeRulesPath(harness);
    const homeDir = path.dirname(homeFile);
    if (!fs.existsSync(homeDir)) continue;

    // Unlink a legacy symlink into the repo.
    let linkTarget = null;
    try { linkTarget = fs.lstatSync(homeFile).isSymbolicLink() ? fs.readlinkSync(homeFile) : null; } catch {}
    if (linkTarget) {
      const resolved = path.resolve(path.dirname(homeFile), linkTarget);
      if (resolved === repoRoot || resolved.startsWith(`${repoRoot}${path.sep}`)) {
        if (dryRun) {
          console.log(`[dry-run] would cleanup legacy symlink: ${homeFile}`);
        } else {
          fs.unlinkSync(homeFile);
          console.log(`cleanup: ${homeFile}`);
        }
      }
    }

    const content = renderContent(harness, enabledIds);
    writeRulesBlock(homeFile, content, dryRun);
    // Claude's legacy pre-managed-block rules file predates this module and is Claude-specific
    // migration cleanup, not a generalizable provider concept — kept as a literal check rather
    // than registry-derived data.
    if (harness === "claude") removeLegacyClaudeRulesFile(dryRun);
    if (hasHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride")) {
      const overrideFile = resolveHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride");
      if (fs.existsSync(overrideFile)) {
        writeManagedBlock(overrideFile, CODE_STYLE_BLOCK, content, dryRun);
      }
    }
  }
}

export function removeHomeRules({ dryRun = false, harness: targetHarness } = {}) {
  const harnesses = targetHarness ? [targetHarness] : knownHarnessIds();
  for (const harness of harnesses) {
    const homeFile = homeRulesPath(harness);
    removeManagedBlocks(homeFile, [CODE_STYLE_BLOCK, AGENTS_IMPORT_BLOCK], dryRun);
    if (harness === "claude") removeLegacyClaudeRulesFile(dryRun);
    if (hasHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride")) {
      removeManagedBlock(resolveHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride"), CODE_STYLE_BLOCK, dryRun);
    }
  }
}

// Check whether present home rules files match the current render (base + enabled registry).
// Returns true if all present harnesses are current. Prints ok/fail lines to stdout/stderr.
export function checkHomeRules({ quiet = false } = {}) {
  const enabledIds = effectiveEnabledIds(loadPackageCatalog());
  let ok = true;
  for (const harness of knownHarnessIds()) {
    const homeFile = homeRulesPath(harness);
    if (!fs.existsSync(path.dirname(homeFile))) continue;
    if (!fs.existsSync(homeFile)) {
      console.error(`fail: ${homeFile} missing`);
      ok = false;
      continue;
    }
    const expected = renderContent(harness, enabledIds);
    const actual = fs.readFileSync(homeFile, "utf8");
    const matches = actual.includes(blockText(CODE_STYLE_BLOCK, expected).trimEnd());
    if (matches) {
      if (!quiet) console.log(`ok: ${homeFile}`);
    } else {
      console.error(`fail: ${homeFile} out of date (run roborepo update to refresh)`);
      ok = false;
    }
    if (hasHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride")) {
      const overrideFile = resolveHarnessPath(getHarnessProvider(harness).manifest, "rulesOverride");
      if (fs.existsSync(overrideFile)) {
        const override = fs.readFileSync(overrideFile, "utf8");
        if (!override.includes(blockText(CODE_STYLE_BLOCK, expected).trimEnd())) {
          console.error(`fail: ${overrideFile} out of date (run roborepo update to refresh)`);
          ok = false;
        } else if (!quiet) {
          console.log(`ok: ${overrideFile}`);
        }
      }
    }
  }
  return ok;
}

export function renderedRulesMatches(harness, filePath) {
  try {
    const enabledIds = effectiveEnabledIds(loadPackageCatalog());
    const expected = renderContent(harness, enabledIds);
    const actual = fs.readFileSync(filePath, "utf8");
    return actual.includes(blockText(CODE_STYLE_BLOCK, expected).trimEnd());
  } catch {
    return false;
  }
}

// --------------------------------------------------------------------------- CLI entry

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    console.log(`usage: rules-render.mjs [<${knownHarnessIds().join("|")}>] [--dry-run]
       rules-render.mjs --check [--quiet]
       rules-render.mjs [<harness>] --remove-managed [--dry-run]
       rules-render.mjs <harness> --matches <file>

Renders home rules (CLAUDE.md/AGENTS.md/...) from globals/system/rules fragments for one harness,
or every known harness when none is given.`);
    process.exit(0);
  }
  const dryRun = args.includes("--dry-run");
  const checkMode = args.includes("--check") || args.includes("check");
  const harness = args.find((a) => knownHarnessIds().includes(a));
  if (checkMode) {
    process.exit(checkHomeRules({ quiet: args.includes("--quiet") }) ? 0 : 1);
  } else if (args.includes("--remove-managed")) {
    removeHomeRules({ dryRun, harness });
  } else if (args.includes("--matches")) {
    const file = args[args.indexOf("--matches") + 1];
    if (!harness || !file) {
      console.error(`usage: rules-render.mjs <${knownHarnessIds().join("|")}> --matches <file>`);
      process.exit(2);
    }
    process.exit(renderedRulesMatches(harness, file) ? 0 : 1);
  } else {
    renderHomeRules({ dryRun, harness });
  }
}
