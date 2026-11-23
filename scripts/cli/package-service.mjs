// The package service: one domain layer for package sources and the install lifecycle, so the CLI
// and the portal read and change the same state. Callers present results; they do not reach into
// sources, the lock, or the store themselves.
//
// Three states, kept apart:
//   available  a configured source offers the package
//   installed  RoboRepo has a record of it (and, for a remote package, a local copy)
//   active     it is applied to the harnesses (the enable/disable lifecycle in packages.mjs)
// Install never activates and refresh never installs. Enabling a package from a live source (the
// built-in library or a local folder) installs it implicitly, by recording it, as it always has.
import fs from "node:fs";
import path from "node:path";
import {
  BUILTIN_SOURCE_ID,
  LOCAL_SOURCE_ID,
  PackageSourceError,
  SOURCE_TABS,
  findSource,
  isLiveSource,
  parsePackageReference,
  qualifiedName,
  readSourceConfig,
  sourceDirectory,
  sourceTab,
  tabLabel,
  writeSourceConfig,
} from "./package-sources.mjs";
import { composePackageCatalog, listPackageCandidates, normalizePackageEntry, validatePackageCatalog } from "./package-catalog.mjs";
import { createSourceAdapter } from "./package-source-adapters.mjs";
import { readPackageLock } from "./package-lock.mjs";
import { deleteMaterializedCopy, promoteMaterialized, recordLiveInstall, removeInstalled } from "./package-install-store.mjs";
import {
  contentsSummary,
  forgetGitSourceCache,
  normalizeGitUrl,
  pruneGitCache,
  readGitCatalog,
  readTrustedCatalog,
  refreshGitSource,
  trustedEntryFor,
} from "./package-source-git.mjs";
import { effectiveEnabledIds, readEnabledPackagesRegistry, selectedRootIds } from "./package-state.mjs";

// Exit codes for non-interactive callers. 2 matches the CLI's existing usage/refusal code.
export const SERVICE_EXIT_CODES = {
  usage: 2,
  ambiguous: 3,
  confirmationRequired: 4,
  unavailable: 5,
  refused: 6,
  invalid: 7,
};

export class PackageServiceError extends Error {
  constructor(message, { code = "refused", details = null } = {}) {
    super(message);
    this.name = "PackageServiceError";
    this.code = code;
    this.exitCode = SERVICE_EXIT_CODES[code] ?? 1;
    this.details = details;
  }
}

const SLUG_RE = /^[a-z0-9][a-z0-9-]*$/;

// ---------------------------------------------------------------------------------------------
// Sources

export function listSources() {
  const lock = readPackageLock();
  const installed = Object.values(lock.packages);
  return readSourceConfig().sources.map((record) => sourceSummary(record, installed));
}

export function sourceInfo(sourceId) {
  const record = requireSource(sourceId);
  const summary = sourceSummary(record, Object.values(readPackageLock().packages));
  return { ...summary, packages: availableFromSource(record).map((pkg) => pkg.id) };
}

function sourceSummary(record, installed) {
  const catalog = record.type === "git" ? readGitCatalog(record.id) : null;
  let available = 0;
  let error = null;
  try {
    available = availableFromSource(record).length;
  } catch (err) {
    error = err.message;
  }
  return {
    id: record.id,
    type: record.type,
    trust: record.trust,
    enabled: record.enabled,
    tab: sourceTab(record),
    tabLabel: tabLabel(sourceTab(record)),
    location: record.type === "git" ? record.url : sourceDirectory(record),
    display: record.display || null,
    removable: ![BUILTIN_SOURCE_ID, LOCAL_SOURCE_ID].includes(record.id),
    available,
    installed: installed.filter((entry) => entry.sourceId === record.id).map((entry) => entry.packageId),
    revision: catalog?.revision || null,
    refreshedAt: catalog?.refreshedAt || null,
    error,
  };
}

function requireSource(sourceId, sources = readSourceConfig().sources) {
  const record = findSource(sourceId, sources);
  if (!record) throw new PackageServiceError(`unknown package source: ${sourceId}`, { code: "usage" });
  return record;
}

// Add a git repository or a local folder as a source. A git source is fetched and listed before
// its record is written, so an unreachable repo or a repo without packages leaves no state.
export function addSource({ location, id = null }) {
  const text = String(location || "").trim();
  if (!text) throw new PackageServiceError("usage: roborepo package source add <github-url|folder> [--id <id>]", { code: "usage" });
  const sources = readSourceConfig().sources;
  if (id !== null && !SLUG_RE.test(id)) throw new PackageServiceError(`invalid package source id: ${id}`, { code: "usage" });
  const looksLikeFolder = !/^(https?:|file:|github\.com\/)/.test(text) && fs.existsSync(text);
  if (looksLikeFolder) return addPathSource(text, id, sources);
  let normalized;
  try {
    normalized = normalizeGitUrl(text);
  } catch (err) {
    throw new PackageServiceError(err.message, { code: "usage" });
  }
  refuseReusedSourceId(id || normalized.defaultId, normalized.url);
  const existing = sources.find((record) => record.type === "git" && record.url === normalized.url);
  if (existing) throw new PackageServiceError(`${normalized.display} is already the package source ${existing.id}`, { code: "refused" });
  const sourceId = id || normalized.defaultId;
  if (findSource(sourceId, sources)) throw new PackageServiceError(`package source ${sourceId} already exists; pass --id to choose another`, { code: "refused" });
  const trusted = trustedEntryFor(normalized.url);
  const record = {
    id: sourceId,
    type: "git",
    url: normalized.url,
    display: normalized.display,
    trust: trusted ? "trusted" : "unverified",
    enabled: true,
    addedAt: new Date().toISOString(),
  };
  const { catalog } = runRefresh(record, { revision: trusted?.commit || null });
  writeSourceConfig([...sources, record]);
  return { source: sourceSummary(record, []), packages: catalog.packages.map((item) => item.packageId), trusted: Boolean(trusted), collisions: [] };
}

function addPathSource(folder, id, sources) {
  const dir = path.resolve(folder);
  const sourceId = id || path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(sourceId)) throw new PackageServiceError(`cannot derive a source id from ${dir}; pass --id`, { code: "usage" });
  if (findSource(sourceId, sources)) throw new PackageServiceError(`package source ${sourceId} already exists; pass --id to choose another`, { code: "refused" });
  if (sources.some((record) => record.type === "path" && sourceDirectory(record) === dir)) {
    throw new PackageServiceError(`${dir} is already a package source`, { code: "refused" });
  }
  const record = { id: sourceId, type: "path", path: dir, trust: "local", enabled: true, addedAt: new Date().toISOString() };
  // List it once so a folder with an invalid package is refused before it is recorded.
  candidatesFromLiveSource(record);
  writeSourceConfig([...sources, record]);
  return { source: sourceSummary(record, []), packages: availableFromSource(record).map((pkg) => pkg.id), trusted: false, collisions: newCollisions() };
}

// A source id that installed packages still name belongs to those packages' repository. Reusing
// it for another repository would let a later update replace one repo's content with another's
// under an unchanged name.
function refuseReusedSourceId(sourceId, url) {
  const named = Object.values(readPackageLock().packages).filter((entry) => entry.sourceId === sourceId);
  if (named.some((entry) => entry.url && entry.url !== url)) {
    throw new PackageServiceError(
      `installed packages still name source ${sourceId} for another repository (${named.map((entry) => entry.packageId).join(", ")}); choose another --id or remove them first`,
      { code: "refused" },
    );
  }
}

// IDs two live sources now offer with no recorded choice: until the user picks one, the catalog
// refuses to load, so `source add` says so at once.
function newCollisions() {
  try {
    return composePackageCatalog().collisions;
  } catch {
    return [];
  }
}

// Removing a source never deletes user files and never silently uninstalls. With installed
// packages from it, removal is refused unless `keepInstalled`, which leaves them installed and
// usable without a source until the user removes them.
export function removeSource(sourceId, { keepInstalled = false } = {}) {
  const sources = readSourceConfig().sources;
  const record = requireSource(sourceId, sources);
  if (record.id === BUILTIN_SOURCE_ID || record.id === LOCAL_SOURCE_ID) {
    throw new PackageServiceError(`package source ${record.id} cannot be removed${record.id === LOCAL_SOURCE_ID ? "; disable it instead" : ""}`, { code: "refused" });
  }
  const installed = Object.values(readPackageLock().packages).filter((entry) => entry.sourceId === record.id).map((entry) => entry.packageId);
  if (installed.length > 0 && keepInstalled && record.type !== "git") {
    throw new PackageServiceError(
      `package source ${record.id} is a folder; its packages are used in place and cannot stay installed without it. Remove them first with \`roborepo package remove <package>\``,
      { code: "refused", details: { installed } },
    );
  }
  if (installed.length > 0 && !keepInstalled) {
    throw new PackageServiceError(
      `package source ${record.id} has installed packages: ${installed.join(", ")}. Remove them first with \`roborepo package remove <package>\`, or pass --keep-installed to keep them installed without a source`,
      { code: "refused", details: { installed } },
    );
  }
  writeSourceConfig(sources.filter((entry) => entry.id !== record.id));
  if (record.type === "git") {
    // Installed copies live in the install store, not the cache, so they survive this.
    forgetGitSourceCache(record.id);
  }
  return { removed: record.id, keptInstalled: installed };
}

export function setSourceEnabled(sourceId, enabled) {
  const sources = readSourceConfig().sources;
  const record = requireSource(sourceId, sources);
  if (record.id === BUILTIN_SOURCE_ID && !enabled) throw new PackageServiceError("the builtin package source cannot be disabled", { code: "refused" });
  writeSourceConfig(sources.map((entry) => (entry.id === record.id ? { ...entry, enabled } : entry)));
  return sourceSummary({ ...record, enabled }, Object.values(readPackageLock().packages));
}

// Refresh one git source, or every enabled git source. A live source is read from disk on every
// use and has nothing to refresh. A failed refresh keeps the last good listing.
export function refreshSources(sourceId = null) {
  const sources = readSourceConfig().sources;
  const targets = sourceId ? [requireSource(sourceId, sources)] : sources.filter((record) => record.enabled && record.type === "git");
  return targets.map((record) => {
    if (record.type !== "git") return { id: record.id, live: true, changed: false };
    try {
      const { catalog, changed, previousRevision } = runRefresh(record);
      pruneGitCache(record.id, [catalog.revision, ...Object.values(readPackageLock().packages).filter((entry) => entry.sourceId === record.id).map((entry) => entry.resolved)]);
      return { id: record.id, changed, revision: catalog.revision, previousRevision: previousRevision ?? null, packages: catalog.packages.map((item) => item.packageId) };
    } catch (err) {
      if (sourceId) throw toServiceError(err);
      return { id: record.id, error: err.message, revision: readGitCatalog(record.id)?.revision || null };
    }
  });
}

function runRefresh(record, options = {}) {
  try {
    return refreshGitSource(record, {
      ...options,
      validate: (dir, packageId) => normalizePackageEntry({ sourceId: record.id, packageId, root: dir, file: path.join(dir, "package.config.json") }, record),
    });
  } catch (err) {
    throw toServiceError(err);
  }
}

function toServiceError(err) {
  if (err instanceof PackageServiceError) return err;
  if (err instanceof PackageSourceError) {
    const code = err.code === "unavailable" ? "unavailable" : err.code === "invalid-url" ? "usage" : "invalid";
    return new PackageServiceError(err.message, { code });
  }
  return new PackageServiceError(err.message, { code: "invalid" });
}

export function trustedCatalog() {
  const sources = readSourceConfig().sources;
  return readTrustedCatalog().map((entry) => ({
    ...entry,
    addedAs: sources.find((record) => record.type === "git" && record.url === entry.url)?.id || null,
  }));
}

// ---------------------------------------------------------------------------------------------
// Available packages

function candidatesFromLiveSource(record) {
  return listPackageCandidates({ sources: [{ ...record, enabled: true }], lock: { packages: {} } }).candidates;
}

// Normalized packages a source offers. Git entries come from the source's cached listing.
function availableFromSource(record) {
  if (isLiveSource(record)) return candidatesFromLiveSource(record);
  return createSourceAdapter(record).list().map((entry) => ({
    ...normalizePackageEntry(entry, record),
    revision: entry.revision,
    contents: entry.contents,
  }));
}

// Every package every enabled source offers, one row per (source, package).
export function listAvailablePackages() {
  const out = [];
  for (const record of readSourceConfig().sources) {
    if (!record.enabled) continue;
    out.push(...availableFromSource(record));
  }
  return out;
}

// Pick the one available package a reference names. A qualified reference names it exactly. A
// bare ID resolves to the source an existing record names, or to the only source offering it;
// several sources and no record is an ambiguity the user settles.
export function resolvePackageReference(reference, { available = listAvailablePackages(), lock = readPackageLock() } = {}) {
  const { sourceId, packageId } = parsePackageReference(reference);
  if (!packageId) throw new PackageServiceError("a package name is required", { code: "usage" });
  if (sourceId) {
    const exact = available.find((pkg) => pkg.sourceId === sourceId && pkg.id === packageId);
    if (!exact) throw new PackageServiceError(`source ${sourceId} does not offer ${packageId}`, { code: "usage" });
    return exact;
  }
  const group = available.filter((pkg) => pkg.id === packageId);
  const recorded = lock.packages[packageId];
  if (recorded) {
    const chosen = group.find((pkg) => pkg.sourceId === recorded.sourceId);
    if (chosen) return chosen;
    // The recorded source no longer offers it. Another source's package is never substituted
    // for a bare name; the user names the source they want.
    throw new PackageServiceError(
      `${packageId} was installed from ${recorded.sourceId}, which no longer offers it${group.length ? `; to switch, install a qualified name: ${group.map((pkg) => pkg.qualifiedName).join(", ")}` : ""}`,
      { code: "unavailable", details: { packageId, recordedSource: recorded.sourceId, candidates: group.map((pkg) => pkg.qualifiedName) } },
    );
  }
  if (group.length === 1) return group[0];
  if (group.length === 0) throw new PackageServiceError(`no source offers ${packageId}`, { code: "usage" });
  throw ambiguityError(packageId, group.map((pkg) => pkg.qualifiedName));
}

export function ambiguityError(packageId, candidates) {
  return new PackageServiceError(
    `Multiple sources provide "${packageId}":\n\n${candidates.map((name) => `  ${name}`).join("\n")}\n\nChoose a qualified package name.`,
    { code: "ambiguous", details: { packageId, candidates } },
  );
}

// ---------------------------------------------------------------------------------------------
// Install, update, remove

// What installing `reference` would put on this machine, without changing anything. The portal and
// the CLI show this before an install.
export function previewInstall(reference) {
  const available = listAvailablePackages();
  const lock = readPackageLock();
  const pkg = resolvePackageReference(reference, { available, lock });
  // Everything the install would bring, dependencies included, so the user sees each package's
  // contents before agreeing to any of them.
  const plan = installPlan(pkg, available, lock);
  return {
    qualifiedName: pkg.qualifiedName,
    sourceId: pkg.sourceId,
    packageId: pkg.id,
    trust: pkg.trust,
    tab: pkg.tab,
    revision: pkg.revision || null,
    needsConfirmation: plan.some((entry) => entry.trust === "unverified"),
    contents: pkg.contents || contentsSummary(pkg.sourceRoot),
    packages: plan.map((entry) => previewOf(entry)),
  };
}

// Install a package (and what it requires from the same source). `confirmed` must be true for an
// unverified source: the caller has shown previewInstall's contents to the user and they agreed.
export function installPackage(reference, { confirmed = false } = {}) {
  const available = listAvailablePackages();
  const lock = readPackageLock();
  const pkg = resolvePackageReference(reference, { available, lock });
  const plan = installPlan(pkg, available, lock);
  const unconfirmed = plan.filter((entry) => entry.trust === "unverified");
  if (unconfirmed.length > 0 && !confirmed) {
    throw new PackageServiceError(
      `${unconfirmed.map((entry) => entry.qualifiedName).join(", ")} ${unconfirmed.length === 1 ? "comes" : "come"} from an unverified source; review the contents and confirm to install`,
      { code: "confirmationRequired", details: { preview: unconfirmed.map((entry) => previewOf(entry)) } },
    );
  }
  refuseSwitchingActive(plan, lock);
  validateProspective(plan);
  const installed = [];
  for (const entry of plan) installed.push(installOne(entry, lock));
  return { installed, preview: plan.map((entry) => previewOf(entry)) };
}

function previewOf(pkg) {
  return {
    qualifiedName: pkg.qualifiedName,
    trust: pkg.trust,
    sourceType: pkg.sourceType,
    revision: pkg.revision || null,
    contents: pkg.contents || contentsSummary(pkg.sourceRoot),
  };
}

// The package and every package it requires that is not already resolvable. A requirement is
// looked for in the requiring package's own source first, then by the usual reference rules; one
// that stays ambiguous stops the install.
function installPlan(root, available, lock) {
  const plan = [];
  const seen = new Set();
  const effective = new Map(safeCompose().packages.map((pkg) => [pkg.id, pkg]));
  const visit = (pkg) => {
    if (seen.has(pkg.id)) return;
    seen.add(pkg.id);
    for (const dep of pkg.requires || []) {
      const sameSource = available.find((candidate) => candidate.sourceId === pkg.sourceId && candidate.id === dep);
      if (sameSource) {
        visit(sameSource);
        continue;
      }
      if (effective.has(dep)) continue;
      const group = available.filter((candidate) => candidate.id === dep);
      if (group.length === 0) throw new PackageServiceError(`${pkg.qualifiedName} requires ${dep}, which no source offers`, { code: "unavailable" });
      if (group.length > 1 && !lock.packages[dep]) throw ambiguityError(dep, group.map((candidate) => candidate.qualifiedName));
      visit(resolvePackageReference(dep, { available, lock }));
    }
    plan.push(pkg);
  };
  visit(root);
  return plan;
}

function safeCompose() {
  try {
    return composePackageCatalog();
  } catch {
    return { packages: [], collisions: [], unresolved: [] };
  }
}

// Switching an active package to another source would change what is applied under the user's
// feet; they disable it first.
function refuseSwitchingActive(plan, lock) {
  const catalog = safeCompose().packages;
  const active = new Set(effectiveEnabledIds(catalog));
  for (const pkg of plan) {
    const recorded = lock.packages[pkg.id];
    if (recorded && recorded.sourceId !== pkg.sourceId && active.has(pkg.id)) {
      throw new PackageServiceError(`${pkg.id} is active from ${recorded.sourceId}; disable it before installing it from ${pkg.sourceId}`, { code: "refused" });
    }
  }
}

// The catalog as it would be after the install must still validate (no skill or command claimed
// twice, every requirement present), or nothing is installed.
function validateProspective(plan) {
  const { packages } = safeCompose();
  const replaced = new Set(plan.map((pkg) => pkg.id));
  const prospective = [...packages.filter((pkg) => !replaced.has(pkg.id)), ...plan];
  try {
    validatePackageCatalog(prospective);
  } catch (err) {
    throw new PackageServiceError(`cannot install ${plan.at(-1).qualifiedName}: ${err.message}`, { code: "invalid" });
  }
}

function installOne(pkg, lock) {
  if (isLiveSource({ type: pkg.sourceType })) {
    const previous = lock.packages[pkg.id];
    const record = recordLiveInstall(pkg);
    // Switching from a copied package to a live one leaves nothing pointing at the old copy.
    if (previous?.kind === "materialized") deleteMaterializedCopy(previous.installedPath);
    return { qualifiedName: pkg.qualifiedName, kind: "live", path: record.resolved, changed: true };
  }
  const record = findSource(pkg.sourceId);
  if (!record) throw new PackageServiceError(`package source ${pkg.sourceId} no longer exists`, { code: "unavailable" });
  const adapter = createSourceAdapter(record);
  const resolution = adapter.resolve(pkg.id);
  const current = lock.packages[pkg.id];
  // Already installed from this source: install never moves the pin. A newer revision goes
  // through `update`, which shows the change and re-applies an active package.
  if (current && current.sourceId === resolution.sourceId && current.kind === "materialized" && fs.existsSync(current.installedPath || "")) {
    const newer = current.resolved !== resolution.resolved ? resolution.resolved : null;
    return { qualifiedName: pkg.qualifiedName, kind: "materialized", revision: current.resolved, changed: false, newerRevision: newer };
  }
  const folder = adapter.materialize(resolution);
  const { record: written, previous } = promoteMaterialized({
    sourceFolder: folder,
    resolution,
    metadata: { collection: pkg.collection || null, url: record.url },
  });
  if (previous?.kind === "materialized" && previous.installedPath !== written.installedPath) deleteMaterializedCopy(previous.installedPath);
  return { qualifiedName: pkg.qualifiedName, kind: "materialized", revision: written.resolved, changed: true };
}

// Move an installed package to its source's newest revision (for a trusted source, the commit the
// trusted catalog has reviewed). Returns the change for the caller to show; nothing moves until
// the caller passes `confirmed` after showing it. A live package is used in place, so "update"
// re-records it.
// `expectedRevision` is the revision the caller showed the user; when given, the update moves to
// exactly that revision, so a branch that moved during the prompt cannot slip in unreviewed.
export async function updatePackage(reference, { confirmed = false, expectedRevision = null, reapply = null } = {}) {
  const lock = readPackageLock();
  const { packageId, sourceId } = parsePackageReference(reference);
  const current = lock.packages[packageId];
  if (!current || (sourceId && current.sourceId !== sourceId)) throw new PackageServiceError(`${reference} is not installed`, { code: "usage" });
  if (current.kind === "live") {
    const pkg = safeCompose().packages.find((entry) => entry.id === packageId && entry.sourceId === current.sourceId);
    if (!pkg) throw new PackageServiceError(`${qualifiedName(current.sourceId, packageId)} is unresolved; its source no longer offers it`, { code: "unavailable" });
    recordLiveInstall(pkg);
    return { qualifiedName: pkg.qualifiedName, live: true, changed: false, message: "used in place from its folder; nothing to download" };
  }
  const record = findSource(current.sourceId);
  if (!record) throw new PackageServiceError(`package source ${current.sourceId} no longer exists; the installed copy stays as it is`, { code: "unavailable" });
  if (current.url && record.url !== current.url) {
    throw new PackageServiceError(`${qualifiedName(current.sourceId, packageId)} was installed from ${current.url}, but source ${record.id} now points at ${record.url}; remove the package and install it again to switch repositories`, { code: "refused" });
  }
  const refreshed = runRefresh(record, expectedRevision ? { revision: expectedRevision } : {});
  const latest = refreshed.catalog.revision;
  const name = qualifiedName(current.sourceId, packageId);
  if (latest === current.resolved) return { qualifiedName: name, changed: false, revision: latest };
  const entry = refreshed.catalog.packages.find((item) => item.packageId === packageId);
  if (!entry) throw new PackageServiceError(`${name} is no longer in ${record.display || record.id} at ${latest.slice(0, 12)}; the installed copy stays as it is`, { code: "unavailable" });
  const adapter = createSourceAdapter(record);
  const resolution = adapter.resolve(packageId);
  const nextFolder = adapter.materialize(resolution);
  const change = {
    qualifiedName: name,
    from: current.resolved,
    to: latest,
    files: treeDiff(current.installedPath, nextFolder),
    contents: entry.contents,
  };
  if (!confirmed) {
    throw new PackageServiceError(`${name} has a new revision ${latest.slice(0, 12)}; review the change and confirm to update`, { code: "confirmationRequired", details: { change } });
  }
  const pkg = availableFromSource(record).find((candidate) => candidate.id === packageId);
  validateProspective([pkg]);
  const { record: written, previous } = promoteMaterialized({
    sourceFolder: nextFolder,
    resolution,
    metadata: { collection: pkg.collection || null, url: record.url },
  });
  const reapplied = reapply ? await reapply(packageId) : false;
  if (previous?.installedPath && previous.installedPath !== written.installedPath) deleteMaterializedCopy(previous.installedPath);
  pruneGitCache(record.id, [latest, ...Object.values(readPackageLock().packages).filter((r) => r.sourceId === record.id).map((r) => r.resolved)]);
  return { ...change, changed: true, reapplied };
}

// Files added, removed, and changed between two package folders.
function treeDiff(fromDir, toDir) {
  const files = (dir) => {
    const out = new Map();
    const walk = (prefix) => {
      for (const entry of safeReaddir(path.join(dir, prefix))) {
        if (entry.name === ".roborepo-source.json") continue;
        const rel = path.join(prefix, entry.name);
        if (entry.isDirectory()) walk(rel);
        else if (entry.isFile()) out.set(rel.split(path.sep).join("/"), fs.readFileSync(path.join(dir, rel)));
      }
    };
    walk("");
    return out;
  };
  const before = fromDir && fs.existsSync(fromDir) ? files(fromDir) : new Map();
  const after = files(toDir);
  return {
    added: [...after.keys()].filter((rel) => !before.has(rel)).sort(),
    removed: [...before.keys()].filter((rel) => !after.has(rel)).sort(),
    changed: [...after.keys()].filter((rel) => before.has(rel) && !before.get(rel).equals(after.get(rel))).sort(),
  };
}

function safeReaddir(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
}

// Remove an installed package. A System package is never removable. An active package is first
// turned off through `disable` (the same lifecycle the enable switch uses); if it stays on because
// another active package requires it, nothing is removed. A path package's folder is never touched.
export async function removePackage(reference, { disable = null } = {}) {
  const { packageId, sourceId } = parsePackageReference(reference);
  const lock = readPackageLock();
  const record = lock.packages[packageId];
  const composed = safeCompose();
  const pkg = composed.packages.find((entry) => entry.id === packageId);
  const effectiveSource = record?.sourceId || pkg?.sourceId;
  if (sourceId && effectiveSource && sourceId !== effectiveSource) {
    throw new PackageServiceError(`${packageId} is installed from ${effectiveSource}, not ${sourceId}`, { code: "usage" });
  }
  const tab = record ? sourceTab({ type: record.sourceType || "git" }) : pkg?.tab;
  if (tab === "system" || effectiveSource === BUILTIN_SOURCE_ID) {
    throw new PackageServiceError(`${packageId} is a System package and cannot be removed; disable it instead`, { code: "refused" });
  }
  if (!record && !pkg) throw new PackageServiceError(`${reference} is not installed`, { code: "usage" });
  if (!record) return { qualifiedName: pkg.qualifiedName, removed: false, disabled: false, message: "not installed; nothing to remove" };

  const active = new Set(effectiveEnabledIds(composed.packages));
  let disabled = false;
  if (active.has(packageId)) {
    if (!disable) throw new PackageServiceError(`${packageId} is active; disable it first`, { code: "refused" });
    const roots = selectedRootIds(composed.packages, readEnabledPackagesRegistry());
    const result = await disable(packageId);
    disabled = true;
    const after = safeCompose().packages;
    if (effectiveEnabledIds(after).includes(packageId)) {
      throw new PackageServiceError(`${packageId} stays active because other packages require it; nothing was removed`, { code: "refused", details: { roots, result } });
    }
  }
  const removed = removeInstalled(packageId);
  return { qualifiedName: qualifiedName(record.sourceId, packageId), removed: removed.removed, deletedCopy: removed.deletedCopy, disabled };
}

// ---------------------------------------------------------------------------------------------
// The package view the CLI and portal read

// One row per package a user can see: everything effective in the catalog, plus remote packages
// that are available but not installed. Each row names its source, tab, trust, and its available,
// installed, and active state.
export function packageView({ includeAvailable = true } = {}) {
  const lock = readPackageLock();
  const sources = readSourceConfig().sources;
  const composed = composePackageCatalog({ lock, sources });
  const active = new Set(effectiveEnabledIds(composed.packages));
  const rows = composed.packages.map((pkg) => viewRow(pkg, { lock, active, available: true, sources }));
  if (includeAvailable) {
    for (const record of sources) {
      if (!record.enabled || record.type !== "git") continue;
      const latest = readGitCatalog(record.id)?.revision || null;
      for (const pkg of availableFromSource(record)) {
        const existing = rows.find((row) => row.id === pkg.id && row.sourceId === pkg.sourceId);
        if (existing) {
          const installedUrl = lock.packages[existing.id]?.url;
          if (installedUrl && installedUrl !== record.url) {
            existing.sourceChanged = true;
            continue;
          }
          existing.latestRevision = latest;
          existing.updateAvailable = Boolean(existing.revision && latest && existing.revision !== latest);
          continue;
        }
        rows.push(viewRow(pkg, { lock, active, available: true, sources }));
      }
    }
  }
  for (const row of rows) {
    if (row.sourceType === "git" && row.installed && !sources.some((record) => record.id === row.sourceId)) row.available = false;
  }
  return {
    tabs: SOURCE_TABS.map((tab) => ({ ...tab, count: rows.filter((row) => row.tab === tab.id).length })),
    packages: rows,
    collisions: composed.collisions,
    unresolved: composed.unresolved,
  };
}

function viewRow(pkg, { lock, active, available, sources }) {
  const record = lock.packages[pkg.id];
  const installedHere = record && record.sourceId === pkg.sourceId;
  return {
    id: pkg.id,
    qualifiedName: pkg.qualifiedName,
    label: pkg.label,
    description: pkg.description,
    sourceId: pkg.sourceId,
    sourceType: pkg.sourceType,
    trust: pkg.trust,
    tab: pkg.tab,
    tabLabel: tabLabel(pkg.tab),
    sourceBadge: sourceBadge(pkg, sources),
    collection: pkg.collection || null,
    available,
    installed: Boolean(installedHere) || (isLiveSource({ type: pkg.sourceType }) && active.has(pkg.id)),
    active: installedHere || isLiveSource({ type: pkg.sourceType }) ? active.has(pkg.id) : false,
    revision: installedHere ? record.resolved : pkg.revision || null,
    latestRevision: pkg.sourceType === "git" ? pkg.revision || null : null,
    updateAvailable: false,
    removable: pkg.tab !== "system" && Boolean(installedHere),
  };
}

// The short provenance label a card shows: nothing for System packages, the source for the rest,
// plus "Trusted" for a package from the trusted catalog.
export function sourceBadge(pkg, sources = null) {
  if (pkg.tab === "system") return null;
  let record = null;
  try {
    record = findSource(pkg.sourceId, sources || readSourceConfig().sources);
  } catch {
    record = null;
  }
  const name = record?.display || pkg.sourceId;
  return pkg.trust === "trusted" ? `${name} · Trusted` : name;
}
