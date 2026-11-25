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
import { readPackageLock, writeLockRecord } from "./package-lock.mjs";
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
import { effectiveEnabledIds, readAppliedPackageIds, readEnabledPackagesRegistry, selectedRootIds } from "./package-state.mjs";
import { hasReplaceOverride, readWorkspaceOverrides } from "./workspace-resources.mjs";

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

// What the CLI prints and the portal shows before anything from an unverified source installs.
export const UNVERIFIED_SOURCE_WARNING = "This repository is not in RoboRepo's trusted catalog. Review each package's contents before installing it.";

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

// Whether `source add` treats a location as a local folder rather than a git URL. The portal asks
// too, since only a git add runs Git.
export function isFolderLocation(location) {
  const text = String(location || "").trim();
  return Boolean(text) && !/^(https?:|file:|github\.com\/)/.test(text) && fs.existsSync(text);
}

// Add a git repository or a local folder as a source. A git source is fetched and listed before
// its record is written, so an unreachable repo or a repo without packages leaves no state.
export function addSource({ location, id = null }) {
  const text = String(location || "").trim();
  if (!text) throw new PackageServiceError("usage: roborepo package source add <github-url|folder> [--id <id>]", { code: "usage" });
  const sources = readSourceConfig().sources;
  if (id !== null && !SLUG_RE.test(id)) throw new PackageServiceError(`invalid package source id: ${id}`, { code: "usage" });
  if (isFolderLocation(text)) return addPathSource(text, id, sources);
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
  return {
    source: sourceSummary(record, []),
    packages: catalog.packages.map((item) => item.packageId),
    trusted: Boolean(trusted),
    warning: record.trust === "unverified" ? UNVERIFIED_SOURCE_WARNING : null,
    collisions: [],
  };
}

function addPathSource(folder, id, sources) {
  const dir = path.resolve(folder);
  const sourceId = id || path.basename(dir).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "");
  if (!SLUG_RE.test(sourceId)) throw new PackageServiceError(`cannot derive a source id from ${dir}; pass --id`, { code: "usage" });
  // A folder has no repository URL, so any copy a git source left installed under this id belongs
  // to another origin, and a later install would replace that copy with the folder's package.
  refuseReusedSourceId(sourceId, null);
  if (findSource(sourceId, sources)) throw new PackageServiceError(`package source ${sourceId} already exists; pass --id to choose another`, { code: "refused" });
  if (sources.some((record) => record.type === "path" && sourceDirectory(record) === dir)) {
    throw new PackageServiceError(`${dir} is already a package source`, { code: "refused" });
  }
  const record = { id: sourceId, type: "path", path: dir, trust: "local", enabled: true, addedAt: new Date().toISOString() };
  // List it once so a folder with an invalid package is refused before it is recorded.
  candidatesFromLiveSource(record);
  writeSourceConfig([...sources, record]);
  return { source: sourceSummary(record, []), packages: availableFromSource(record).map((pkg) => pkg.id), trusted: false, warning: null, collisions: newCollisions() };
}

// A source id that installed packages still name belongs to those packages' repository. Reusing
// it for another repository or a folder (`url` null) would let a later update replace one repo's content with another's
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
  if (record.enabled) refuseOrphaningDependents(record, "remove");
  writeSourceConfig(sources.filter((entry) => entry.id !== record.id));
  if (record.type === "git") {
    // Installed copies live in the install store, not the cache, so they survive this.
    forgetGitSourceCache(record.id);
  }
  return { removed: record.id, keptInstalled: installed };
}

// Packages in the catalog, other than `ids` themselves, that require one of `ids`. Taking such a
// package away would leave a dangling `requires` and stop the whole catalog from loading.
function dependentsOf(ids, packages = safeCompose().packages) {
  const leaving = new Set(ids);
  return packages
    .filter((pkg) => !leaving.has(pkg.id) && (pkg.requires || []).some((dep) => leaving.has(dep)))
    .map((pkg) => pkg.qualifiedName);
}

// A live source's packages that the catalog currently uses from it.
function packagesUsedFrom(record) {
  return safeCompose().packages.filter((pkg) => pkg.sourceId === record.id).map((pkg) => pkg.id);
}

function refuseOrphaningDependents(record, verb) {
  if (!isLiveSource(record)) return;
  const dependents = dependentsOf(packagesUsedFrom(record));
  if (dependents.length > 0) {
    throw new PackageServiceError(
      `cannot ${verb} package source ${record.id}: ${dependents.join(", ")} ${dependents.length === 1 ? "requires" : "require"} its packages`,
      { code: "refused", details: { dependents } },
    );
  }
}

export function setSourceEnabled(sourceId, enabled) {
  const sources = readSourceConfig().sources;
  const record = requireSource(sourceId, sources);
  if (record.id === BUILTIN_SOURCE_ID && !enabled) throw new PackageServiceError("the builtin package source cannot be disabled", { code: "refused" });
  if (!enabled && record.enabled) refuseOrphaningDependents(record, "disable");
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
    integrity: entry.integrity || null,
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
    if (!exact) {
      const disabled = readSourceConfig().sources.find((record) => record.id === sourceId && !record.enabled);
      throw new PackageServiceError(disabled
        ? `source ${sourceId} is disabled; enable it with \`roborepo package source enable ${sourceId}\``
        : `source ${sourceId} does not offer ${packageId}`, { code: "usage" });
    }
    return exact;
  }
  const group = available.filter((pkg) => pkg.id === packageId);
  // A workspace replace override chooses `local`, ahead of any lock record, as the catalog does.
  const overridden = group.find((pkg) => pkg.sourceId === LOCAL_SOURCE_ID);
  if (overridden && hasReplaceOverride("package", packageId, readWorkspaceOverrides())) return overridden;
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
  // contents before agreeing to any of them. The root comes last.
  const plan = installPlan(pkg, available, lock);
  const root = plan.at(-1);
  return {
    qualifiedName: root.qualifiedName,
    sourceId: root.sourceId,
    packageId: root.id,
    trust: root.trust,
    tab: root.tab,
    revision: root.revision || null,
    needsConfirmation: plan.some((entry) => entry.trust === "unverified"),
    warning: plan.some((entry) => entry.trust === "unverified") ? UNVERIFIED_SOURCE_WARNING : null,
    contents: root.contents || contentsSummary(root.sourceRoot),
    packages: plan.map((entry) => previewOf(entry)),
    plan: planDigest(plan),
  };
}

// Install a package (and what it requires from the same source). `confirmed` must be true for an
// unverified source: the caller has shown previewInstall's contents to the user and they agreed.
// `expectedPlan` is previewInstall's `plan` as the caller showed it. When given, the install goes
// ahead only if it would install exactly those packages at those revisions: a source refreshed
// between the preview and the install asks for confirmation again rather than installing a
// revision or a dependency the user never saw.
export function installPackage(reference, { confirmed = false, expectedPlan = null } = {}) {
  const available = listAvailablePackages();
  const lock = readPackageLock();
  const pkg = resolvePackageReference(reference, { available, lock });
  const plan = installPlan(pkg, available, lock);
  if (expectedPlan && !samePlan(planDigest(plan), expectedPlan)) {
    throw planChangedError(plan.at(-1).qualifiedName, plan);
  }
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

// The packages and revisions an install plan names, which is what a confirmation agrees to.
function planDigest(plan) {
  return plan.map((entry) => ({ qualifiedName: entry.qualifiedName, revision: entry.revision || null }));
}

function samePlan(digest, expected) {
  const key = (entries) => entries.map((entry) => `${entry.qualifiedName}@${entry.revision || ""}`).sort().join("\n");
  return Array.isArray(expected) && key(digest) === key(expected);
}

function planChangedError(name, plan) {
  return new PackageServiceError(
    `what installing ${name} would bring changed since it was shown; review it and confirm again`,
    { code: "confirmationRequired", details: { planChanged: true, preview: plan.map((entry) => previewOf(entry)), plan: planDigest(plan) } },
  );
}

// The package and every package it requires that is not already resolvable. A requirement is
// looked for in the requiring package's own source first, then by the usual reference rules; one
// that stays ambiguous stops the install.
function installPlan(root, available, lock) {
  const plan = [];
  const seen = new Set();
  const composed = safeCompose();
  const effective = new Map(composed.packages.map((pkg) => [pkg.id, pkg]));
  const visit = (listed) => {
    if (seen.has(listed.id)) return;
    seen.add(listed.id);
    const pkg = keptInstall(listed, lock, composed.candidates);
    for (const dep of pkg.requires || []) {
      const sameSource = available.find((candidate) => candidate.sourceId === pkg.sourceId && candidate.id === dep);
      const recorded = lock.packages[dep];
      // A requirement already recorded from another source keeps that source: an install never
      // replaces a recorded choice the user did not name. The user installs one explicitly.
      if (sameSource && recorded && recorded.sourceId !== pkg.sourceId) {
        throw new PackageServiceError(
          `${pkg.qualifiedName} requires ${dep}, which is recorded as ${qualifiedName(recorded.sourceId, dep)} and also offered as ${sameSource.qualifiedName}. Install the one you want explicitly first (for example \`roborepo package install ${sameSource.qualifiedName}\`), then retry`,
          { code: "ambiguous", details: { packageId: dep, candidates: [qualifiedName(recorded.sourceId, dep), sameSource.qualifiedName] } },
        );
      }
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

// Installing a package already copied from this source keeps its pin, so the plan uses the
// installed copy: its requirements, not those of a newer listed revision the install will not
// use. A revision change goes through `update`.
function keptInstall(pkg, lock, candidates = []) {
  const recorded = lock.packages[pkg.id];
  if (recorded?.kind !== "materialized" || recorded.sourceId !== pkg.sourceId) return pkg;
  const installed = candidates.find((candidate) => candidate.id === pkg.id && candidate.sourceId === recorded.sourceId && candidate.revision === recorded.resolved);
  if (installed) return { ...installed, contents: contentsSummary(installed.sourceRoot) };
  // The copy is gone. The install restores the pinned revision, so the preview, the plan the user
  // confirms, and the requirements walked all come from that revision's files, not the listing's.
  const source = findSource(pkg.sourceId);
  if (!source) return pkg;
  const pinned = readPinnedRevision(recorded, source, pkg.collection);
  if (!pinned) throw missingPinnedCopyError(pkg, recorded);
  return { ...pinned, contents: contentsSummary(pinned.sourceRoot) };
}

// A copied package as it was at its recorded revision, read from the source's local revision cache
// (never the network), for when its installed copy is gone. Null when that revision is not cached.
function readPinnedRevision(recorded, source, collection = null) {
  let folder;
  try {
    folder = createSourceAdapter(source).materialize(pinnedResolution(recorded, source));
  } catch {
    return null;
  }
  return normalizePackageEntry({
    sourceId: source.id,
    packageId: recorded.packageId,
    root: folder,
    file: path.join(folder, "package.config.json"),
    collection,
    revision: recorded.resolved,
  }, source);
}

// A folder package as it is in the folder its install record names, whatever its source's state.
// Null when that folder no longer holds a readable package.
function readRecordedFolder(record) {
  const file = path.join(record.resolved || "", "package.config.json");
  if (!record.resolved || !fs.existsSync(file)) return null;
  const source = findSource(record.sourceId) || { id: record.sourceId, type: record.sourceType || "path", trust: record.trust || "local" };
  try {
    return normalizePackageEntry({ sourceId: source.id, packageId: record.packageId, root: record.resolved, file }, source);
  } catch {
    return null;
  }
}

function missingPinnedCopyError(pkg, recorded) {
  return new PackageServiceError(`the installed copy of ${pkg.qualifiedName} is missing and its revision ${recorded.resolved.slice(0, 12)} is no longer cached; run \`roborepo package update ${pkg.id}\` to restore it`, { code: "unavailable" });
}

function safeCompose() {
  try {
    return composePackageCatalog();
  } catch {
    return { packages: [], collisions: [], unresolved: [], candidates: [] };
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
    const record = recordLiveInstall(pkg, { replace: true });
    // Switching from a copied package to a live one leaves nothing pointing at the old copy.
    if (previous?.kind === "materialized") deleteMaterializedCopy(previous.installedPath);
    return { qualifiedName: pkg.qualifiedName, kind: "live", path: record.resolved, changed: true };
  }
  const record = findSource(pkg.sourceId);
  if (!record) throw new PackageServiceError(`package source ${pkg.sourceId} no longer exists`, { code: "unavailable" });
  const adapter = createSourceAdapter(record);
  const current = lock.packages[pkg.id];
  const pinnedHere = current && current.sourceId === pkg.sourceId && current.kind === "materialized";
  // Already installed from this source: install never moves the pin. A newer revision goes
  // through `update`, which shows the change and re-applies an active package.
  if (pinnedHere && fs.existsSync(current.installedPath || "")) {
    const listed = adapter.resolve(pkg.id);
    const newer = listed && listed.resolved !== current.resolved ? listed.resolved : null;
    return { qualifiedName: pkg.qualifiedName, kind: "materialized", revision: current.resolved, changed: false, newerRevision: newer };
  }
  let resolution;
  if (pinnedHere) {
    // Installed from this source but the copy is gone: restore the recorded revision, never the
    // listing's newer one.
    resolution = pinnedResolution(current, record);
  } else {
    // The listing is read again here. A refresh since the plan was made must not install a
    // revision the plan, and the preview the user confirmed, did not name.
    resolution = adapter.resolve(pkg.id);
    if (!resolution || resolution.resolved !== pkg.revision || (pkg.integrity && resolution.integrity !== pkg.integrity)) {
      throw planChangedError(pkg.qualifiedName, [pkg]);
    }
  }
  let folder;
  try {
    folder = adapter.materialize(resolution);
  } catch (err) {
    if (!pinnedHere) throw toServiceError(err);
    throw missingPinnedCopyError(pkg, current);
  }
  const { record: written, previous } = promoteMaterialized({
    sourceFolder: folder,
    resolution,
    metadata: { collection: pkg.collection || null, url: record.url },
  });
  if (previous?.kind === "materialized" && previous.installedPath !== written.installedPath) deleteMaterializedCopy(previous.installedPath);
  return { qualifiedName: pkg.qualifiedName, kind: "materialized", revision: written.resolved, changed: true };
}

// The resolution of an installed copy's own recorded revision, for restoring that copy.
function pinnedResolution(current, record) {
  return {
    sourceId: current.sourceId,
    packageId: current.packageId,
    sourceType: current.sourceType || "git",
    trust: record.trust,
    kind: "materialized",
    selector: current.selector ?? null,
    resolved: current.resolved,
    integrity: current.integrity,
    url: current.url ?? record.url,
  };
}

// Move an installed package to its source's newest revision (for a trusted source, the commit the
// trusted catalog has reviewed). Returns the change for the caller to show; nothing moves until
// the caller passes `confirmed` after showing it. A live package is used in place, so "update"
// re-records it.
// `expectedRevision` is the revision the caller showed the user; when given, the update moves to
// exactly that revision, so a branch that moved during the prompt cannot slip in unreviewed.
// `expectedFrom` is the installed revision the shown change started from. When another command
// moved the pin while the user read the change, the update asks again with the current change
// rather than replacing a revision whose differences were never shown.
// When `reapply` fails, the update is rolled back: the previous record and copy stay, so a retry
// starts from the old revision again rather than finding the new one "up to date".
export async function updatePackage(reference, { confirmed = false, expectedRevision = null, expectedFrom = null, reapply = null } = {}) {
  for (const revision of [expectedRevision, expectedFrom]) {
    if (revision !== null && !/^[0-9a-f]{40}$/.test(String(revision))) {
      throw new PackageServiceError(`invalid revision: ${revision}`, { code: "usage" });
    }
  }
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
  if (expectedRevision && record.trust === "trusted" && expectedRevision !== trustedEntryFor(record.url)?.commit) {
    throw new PackageServiceError(`${record.id} is trusted only at its reviewed commit; ${expectedRevision.slice(0, 12)} is not it`, { code: "refused" });
  }
  const refreshed = runRefresh(record, expectedRevision ? { revision: expectedRevision } : {});
  const latest = refreshed.catalog.revision;
  const name = qualifiedName(current.sourceId, packageId);
  const adapter = createSourceAdapter(record);
  const entry = refreshed.catalog.packages.find((item) => item.packageId === packageId);
  if (latest === current.resolved) {
    if (fs.existsSync(path.join(current.installedPath || "", "package.config.json"))) return { qualifiedName: name, changed: false, revision: latest };
    // The pin is current but its copy is gone: restore the copy at the same revision. The user
    // accepted that revision when it was installed, so this needs no new confirmation.
    const resolution = pinnedResolution(current, record);
    let folder;
    try {
      folder = adapter.materialize(resolution);
    } catch (err) {
      throw toServiceError(err);
    }
    promoteMaterialized({ sourceFolder: folder, resolution, metadata: { collection: entry?.collection || null, url: record.url } });
    return { qualifiedName: name, changed: false, restored: true, revision: latest };
  }
  if (!entry) throw new PackageServiceError(`${name} is no longer in ${record.display || record.id} at ${latest.slice(0, 12)}; the installed copy stays as it is`, { code: "unavailable" });
  const resolution = adapter.resolve(packageId);
  // `resolve` reads the source's listing again. If another refresh moved it in between, the copy
  // would come from a revision this change does not show.
  if (!resolution || resolution.resolved !== latest || (resolution.integrity || null) !== (entry.integrity || null)) {
    throw new PackageServiceError(`${record.display || record.id} changed while ${name} was being updated; run the update again`, { code: "refused" });
  }
  let nextFolder;
  try {
    nextFolder = adapter.materialize(resolution);
  } catch (err) {
    throw toServiceError(err);
  }
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
  if (expectedFrom && expectedFrom !== current.resolved) {
    throw new PackageServiceError(`${name} is now installed at ${current.resolved.slice(0, 12)}, not ${expectedFrom.slice(0, 12)} as shown; review the change and confirm again`, { code: "confirmationRequired", details: { change } });
  }
  // The package as it will be after the update, read from the folder being installed.
  const pkg = normalizePackageEntry({ sourceId: record.id, packageId, root: nextFolder, file: path.join(nextFolder, "package.config.json"), collection: entry.collection, revision: latest }, record);
  validateProspective([pkg]);
  const candidates = safeCompose().candidates || [];
  const before = candidates.find((candidate) => candidate.id === packageId && candidate.sourceId === current.sourceId && candidate.revision === current.resolved) || null;
  // The prompt can wait a long time; the pin must still be the one the change was computed from.
  const pinned = readPackageLock().packages[packageId];
  if (!pinned || pinned.sourceId !== current.sourceId || pinned.resolved !== current.resolved) {
    throw new PackageServiceError(`${name} changed while this update was waiting; run the update again to review the current change`, { code: "confirmationRequired" });
  }
  const { record: written, previous } = promoteMaterialized({
    sourceFolder: nextFolder,
    resolution,
    metadata: { collection: pkg.collection || null, url: record.url },
  });
  let reapplied = false;
  if (reapply) {
    try {
      reapplied = await reapply(packageId, { previous: before });
    } catch (err) {
      await rollBackUpdate({ packageId, previous, written, reapply });
      throw new PackageServiceError(`${name} could not be re-applied at ${latest.slice(0, 12)}: ${err?.message || err}\nkept ${current.resolved.slice(0, 12)}; run the update again once the cause is fixed`, { code: "invalid" });
    }
  }
  if (previous?.installedPath && previous.installedPath !== written.installedPath) deleteMaterializedCopy(previous.installedPath);
  pruneGitCache(record.id, [latest, ...Object.values(readPackageLock().packages).filter((r) => r.sourceId === record.id).map((r) => r.resolved)]);
  return { ...change, changed: true, reapplied };
}

// Undo an update whose re-apply failed: point the lock at the previous copy again, re-apply that
// revision (which also removes what the new one registered and the old one does not), then delete
// the new copy. The previous copy was never deleted, so this needs no network.
async function rollBackUpdate({ packageId, previous, written, reapply }) {
  const after = (safeCompose().candidates || []).find((candidate) => candidate.id === packageId && candidate.revision === written.resolved) || null;
  writeLockRecord(previous);
  try {
    await reapply(packageId, { previous: after });
  } catch (err) {
    console.warn(`warn: re-applying ${packageId} at ${previous.resolved.slice(0, 12)} also failed (${err?.message || err}); run \`roborepo config apply\` to repair the harnesses`);
  }
  if (written.installedPath !== previous.installedPath) deleteMaterializedCopy(written.installedPath);
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
// another active package requires it, nothing is removed. A package still on but no longer in the
// catalog is turned off through `retire`, from its own files. A path package's folder is never
// touched.
export async function removePackage(reference, { disable = null, retire = null } = {}) {
  const { packageId, sourceId } = parsePackageReference(reference);
  const lock = readPackageLock();
  const record = lock.packages[packageId];
  const composed = safeCompose();
  const pkg = composed.packages.find((entry) => entry.id === packageId);
  // The lock record is what removal deletes, so it names the source. The catalog's choice can
  // differ: a workspace replace override makes `local` effective while a git copy stays recorded.
  const recordedSource = record?.sourceId || pkg?.sourceId;
  if (sourceId && recordedSource && sourceId !== recordedSource) {
    throw new PackageServiceError(`${packageId} is installed from ${recordedSource}, not ${sourceId}`, { code: "usage" });
  }
  const tab = record ? sourceTab({ type: record.sourceType || "git" }) : pkg?.tab;
  if (tab === "system" || recordedSource === BUILTIN_SOURCE_ID) {
    throw new PackageServiceError(`${packageId} is a System package and cannot be removed; disable it instead`, { code: "refused" });
  }
  if (!record && !pkg) throw new PackageServiceError(`${reference} is not installed`, { code: "usage" });
  if (!record) return { qualifiedName: pkg.qualifiedName, removed: false, disabled: false, message: "not installed; nothing to remove" };
  // Whether the recorded package is the one the catalog uses. A shadowed record goes without
  // touching the package that shadows it: nothing requires the shadowed copy, and the effective
  // package stays on.
  const recordInUse = !pkg || pkg.sourceId === record.sourceId;

  // A copied package leaves the catalog when removed; refuse while another package requires it.
  if (record.kind === "materialized" && recordInUse) {
    const dependents = dependentsOf([packageId], composed.packages);
    if (dependents.length > 0) {
      throw new PackageServiceError(`${packageId} is required by ${dependents.join(", ")}; remove ${dependents.length === 1 ? "it" : "them"} first. Nothing was removed`, { code: "refused", details: { dependents } });
    }
  }

  const active = new Set(effectiveEnabledIds(composed.packages));
  let disabled = false;
  if (pkg && recordInUse && active.has(packageId)) {
    if (!disable) throw new PackageServiceError(`${packageId} is active; disable it first`, { code: "refused" });
    const roots = selectedRootIds(composed.packages, readEnabledPackagesRegistry());
    let result;
    try {
      result = await disable(packageId);
    } catch (err) {
      // The enable/disable lifecycle refuses, for example, a package another active package
      // requires. That is a refusal here too, with its exit code, not a crash.
      if (err?.name !== "PackageMutationError") throw err;
      throw new PackageServiceError(`${err.message}\nnothing was removed`, { code: "refused" });
    }
    disabled = true;
    const after = safeCompose().packages;
    if (effectiveEnabledIds(after).includes(packageId)) {
      throw new PackageServiceError(`${packageId} stays active because other packages require it; nothing was removed`, { code: "refused", details: { roots, result } });
    }
  }
  // Selected or applied, but out of the catalog: its registrations are still in the harnesses.
  const stranded = !pkg && (readEnabledPackagesRegistry().packages.includes(packageId) || readAppliedPackageIds().includes(packageId));
  let warning = null;
  if (stranded) {
    // Its files, as recorded: a copied package's copy, else (copy deleted) its pinned revision from
    // the source's cache; a folder package's recorded folder, read directly so a disabled or
    // repointed source does not hide it or substitute another folder's package.
    let own;
    if (record.kind === "materialized") {
      const source = findSource(record.sourceId);
      own = (composed.candidates || []).find((candidate) => candidate.id === packageId && candidate.sourceId === record.sourceId && candidate.revision === record.resolved)
        || (source ? readPinnedRevision(record, source) : null);
    } else {
      own = readRecordedFolder(record);
    }
    if (!retire) throw new PackageServiceError(`${packageId} is active; disable it first`, { code: "refused" });
    if (own) {
      await retire(own);
    } else {
      // Nothing says what it registered. Refusing would leave a package no command can clear (its
      // source may be gone too), so the cleanup that needs no files runs and the user is told
      // what may remain.
      await retire({ id: packageId, label: packageId, components: [] });
      warning = `the files of ${packageId} are missing, so hooks and hook scripts, MCP servers, config changes, or services it added to your harnesses could not be removed; check them by hand`;
    }
    disabled = true;
  }
  const removed = removeInstalled(packageId);
  return { qualifiedName: qualifiedName(record.sourceId, packageId), removed: removed.removed, deletedCopy: removed.deletedCopy, disabled, ...(warning ? { warning } : {}) };
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
  // An ID is active through the one source the catalog uses for it. Another source's row with the
  // same ID (a git copy shadowed by a local override, say) is not active.
  const inUse = new Map(composed.packages.map((pkg) => [pkg.id, pkg.sourceId]));
  const context = { lock, active, inUse, sources };
  const rows = composed.packages.map((pkg) => viewRow(pkg, { ...context, available: true }));
  // What each enabled git source's current listing offers.
  const offered = new Map();
  for (const record of sources) {
    if (record.enabled && record.type === "git") offered.set(record.id, availableFromSource(record));
  }
  if (includeAvailable) {
    for (const [sourceId, packages] of offered) {
      const record = sources.find((entry) => entry.id === sourceId);
      const latest = readGitCatalog(record.id)?.revision || null;
      for (const pkg of packages) {
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
        rows.push(viewRow(pkg, { ...context, available: true }));
      }
    }
  }
  // An installed copy stays usable after its source stops offering it (the source was removed, or
  // its current revision dropped the package); the row then says it is no longer available.
  for (const row of rows) {
    if (row.sourceType !== "git" || !row.installed) continue;
    const record = sources.find((entry) => entry.id === row.sourceId);
    if (!record) row.available = false;
    else if (offered.has(record.id) && !offered.get(record.id).some((pkg) => pkg.id === row.id)) row.available = false;
  }
  return {
    tabs: SOURCE_TABS.map((tab) => ({ ...tab, count: rows.filter((row) => row.tab === tab.id).length })),
    packages: rows,
    collisions: composed.collisions,
    unresolved: composed.unresolved,
    shadowed: composed.shadowed,
  };
}

function viewRow(pkg, { lock, active, inUse, available, sources }) {
  const record = lock.packages[pkg.id];
  const installedHere = record && record.sourceId === pkg.sourceId;
  const live = isLiveSource({ type: pkg.sourceType });
  const activeHere = inUse.get(pkg.id) === pkg.sourceId && active.has(pkg.id);
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
    installed: Boolean(installedHere) || (live && activeHere),
    active: installedHere || live ? activeHere : false,
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
