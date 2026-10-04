import fs from "node:fs";
import path from "node:path";
import { repoRoot, harnessHome, rootConfigActive, rootConfigBaseline } from "./paths.mjs";
import { presetsStatePath, telemetryDir } from "./state-paths.mjs";
import { effectivePermissions, permissionCategories } from "./config-mutate.mjs";
import { storeHealth } from "./maintenance-stores.mjs";
import { renderMarkdown } from "./markdown-render.mjs";
import {
  renderRulesPreview,
  renderSharedRulesPreview,
  renderHarnessRulesPreview,
  renderEnabledPackageRulesPreview,
} from "./rules-render.mjs";
import {
  loadPackageCatalog,
  isPackageAvailable,
  readPackageCategories,
} from "./package-catalog.mjs";
import { buildPackageLiveState } from "./package-probes.mjs";
import { inspectSkill, skillInventorySource } from "./skill-inventory.mjs";
import { readLiveRulesFile } from "./config-live-rules.mjs";
import { buildRootConfigView } from "./root-config-view.mjs";

// Harnesses whose permission model has no per-item "ask" tier, and which are actually present on
// this machine. The fact and its wording both come from the provider manifest
// (extensions.app.perCommandAsk / perCommandAskNote) — platform code must not hardcode which
// harness has the limitation, so a new provider declares it without editing this file. Returned as
// one section-level notice rather than a per-item flag: the caveat is a property of the harness,
// not of any individual permission.
function askTierNotices() {
  const notices = [];
  for (const provider of listHarnessProviders()) {
    const ext = provider.manifest.extensions?.app ?? {};
    if (ext.perCommandAsk !== false) continue;
    const home = harnessHome[provider.manifest.id];
    if (!home || !fs.existsSync(home)) continue;
    notices.push({
      harness: provider.manifest.id,
      displayName: provider.manifest.displayName,
      note: ext.perCommandAskNote || `${provider.manifest.displayName} has no per-command ask tier.`,
    });
  }
  return notices;
}
import { configRootInspect, printConfigStatus } from "./config-cli-print.mjs";
import {
  packageSkillIds,
  packageSlashCommands,
  readExternalSourceFile,
  readSourceFile,
  readSkillSource,
} from "./config-source-lookup.mjs";
import { renderCommandSourceHtml } from "./config-source-render.mjs";
import { buildContextCost } from "./context-cost.mjs";
import { hasHarnessProvider, listHarnessProviders, getHarnessProvider } from "../harnesses/registry.mjs";
import { confidenceMeetsMinimum, discoverHarnessProviders } from "../harnesses/discovery.mjs";
import { readHarnessState } from "../harnesses/state.mjs";
import { resolveHarnessPath } from "../harnesses/paths.mjs";

const PRESETS_PATH = path.join(repoRoot, "manifests", "platform", "presets.json");
const CLAUDE_SETTINGS = rootConfigActive.claude;

function readJson(filePath, fallback = null) {
  try { return JSON.parse(fs.readFileSync(filePath, "utf8")); } catch { return fallback; }
}

function renderEntry(text) {
  return { text, html: renderMarkdown(text) };
}

// Ordered per-provider entry for the Config grid's columns and defaults popover: one row/column
// per registered provider, never a hardcoded pair. Filenames are derived from each manifest's own
// declared paths — rulesFile/settingsFile straight from paths.rules/paths.rootConfig; hooksFile
// follows extensions.app.hooksStorage (embedded providers show their root-config file, since
// that's genuinely where the hooks live; sidecar providers show their own declared hooks path).
// Exported (not inlined in readConfigSnapshot) so a synthetic third-provider test can call this
// directly without pulling in the rest of the snapshot's disk-reading dependencies.
export function configSnapshotHarnesses() {
  return listHarnessProviders().map((provider) => {
    const { manifest } = provider;
    const sidecar = manifest.extensions?.app?.hooksStorage === "dedicated-json-sidecar";
    return {
      id: provider.id,
      displayName: manifest.displayName,
      rulesFile: path.basename(manifest.paths.rules.path),
      settingsFile: path.basename(manifest.paths.rootConfig.path),
      hooksFile: path.basename(sidecar ? manifest.paths.hooks.path : manifest.paths.rootConfig.path),
    };
  });
}

// The *machine* cohort: which providers this machine actually has, per persisted discovery state.
// Deliberately different from configSnapshotHarnesses() above, which is the *registered* catalog —
// every provider roborepo supports, installed or not. The two are easy to conflate and mean very
// different things to a user: rendering the registered catalog as the primary Agents view tells
// someone with no harnesses installed that they have three, which is the defect this fixes.
//
// A provider appears here when discovery reaches the provider's declared minimum confidence, and
// carries its enabled flag so the UI can distinguish "installed but turned off" from "not here".
// Providers the user explicitly disabled still appear — they exist on the machine; they are just
// not managed. An empty array is a legitimate, common state (fresh install, no harnesses yet).
export function configSnapshotMachineHarnesses() {
  const state = readHarnessState();
  const discoveries = new Map(
    discoverHarnessProviders(listHarnessProviders())
      .filter((entry) => entry.status === "detected")
      .map((entry) => [entry.providerId, entry]),
  );

  return listHarnessProviders()
    .map((provider) => {
      const entry = state.providers[provider.id];
      const discovered = discoveries.get(provider.id);
      if (!entry && !discovered) return null;
      if (!discovered && !confidenceMeetsMinimum(entry?.confidence, provider.manifest.detection.minimumConfidence)) return null;
      const userDisabled = entry?.selectionSource === "user" && entry.enabled === false;
      const confidence = discovered?.confidence ?? entry.confidence;
      const enabled = userDisabled
        ? false
        : discovered
          ? entry?.confidence === "absent" ? true : entry?.enabled ?? true
          : entry.enabled === true;
      return {
        id: provider.id,
        displayName: provider.manifest.displayName,
        enabled,
        confidence,
      };
    })
    .filter(Boolean);
}

export function readConfigSnapshot() {
  const allPackages = loadPackageCatalog({ includeUnavailable: true });
  const availablePackages = allPackages.filter((pkg) => isPackageAvailable(pkg));
  const presetsCatalog = readJson(PRESETS_PATH, { bundles: [], default: [] });
  const presetState = readJson(presetsStatePath, {});
  const telemetryState = readJson(path.join(telemetryDir, "state.json"), null);
  const settings = readJson(CLAUDE_SETTINGS, {});
  // Named behaviors + arbitrary commands, manifest defaults merged with personal overrides.
  // Global only — no per-project scope (see permissions-render.mjs / config-mutate.mjs).
  const permissions = effectivePermissions();

  const selectedBundles = new Set(presetState.selected ?? presetsCatalog.default);

  const packageLiveState = buildPackageLiveState(availablePackages);
  const unavailableSkillIds = new Set(
    allPackages
      .filter((pkg) => !isPackageAvailable(pkg))
      .flatMap((pkg) => (pkg.components || []).filter((c) => c.type === "skill").map((c) => c.id)),
  );
  const packages = availablePackages.map((pkg) => ({
    id: pkg.id,
    label: pkg.label,
    description: pkg.description || null,
    status: packageLiveState.get(pkg.id)?.status || "disabled",
    catalogStatus: pkg.status || "available",
    capabilities: pkg.capabilities || [],
    defaultEnabled: pkg.defaultEnabled === true,
    desired: packageLiveState.get(pkg.id)?.desired || false,
    cliCommands: [...new Set([...(pkg.cliCommands || []), ...pkg.components.filter((c) => c.type === "command").map((c) => c.name)])],
    enabled: packageLiveState.get(pkg.id)?.desired || false,
    componentStatus: packageLiveState.get(pkg.id)?.components || [],
    components: pkg.resources.map((c) => c.type),
    resources: pkg.resources.map((resource) => resource.type),
    presentation: pkg.presentation,
    sourceRoot: pkg.sourceRoot,
    skillIds: pkg.resources.filter((c) => c.type === "skill").map((c) => c.id),
    requires: pkg.requires || [],
    urls: pkg.urls || [],
  }));

  const bundles = presetsCatalog.bundles.map((b) => ({
    id: b.id,
    label: b.label,
    description: b.description || null,
    selected: selectedBundles.has(b.id),
  }));

  const hooks = {};
  for (const [event, entries] of Object.entries(settings.hooks || {})) {
    hooks[event] = Array.isArray(entries) ? entries.length : 0;
  }

  // Build tool list from package resources. installed = symlink at ~/.claude/skills/<name> exists.
  const skillsDir = path.join(harnessHome.claude, "skills");
  const tools = availablePackages
    .flatMap((pkg) => (pkg.resources || [])
      .filter((resource) => resource.type === "skill")
      .map((resource) => {
        const command = (resource.entrypoints || []).find((entrypoint) => entrypoint.type === "slash-command");
        return {
          id: resource.id,
          label: resource.id,
          packageId: pkg.id,
          invocation: resource.invocation,
          hasCommand: !!command,
          command: command?.name || null,
          description: command?.description || pkg.description || null,
          commandHarnesses: command?.harnesses || [],
          installed: fs.existsSync(path.join(skillsDir, resource.id)),
          inventory: inspectSkill(resource.id),
        };
      }))
    .filter((s) => !unavailableSkillIds.has(s.id));

  const snapshot = {
    // Ordered list of registered providers, for the Config grid's per-harness columns and any
    // other client rendering that needs one row/column per harness rather than a lookup-by-id.
    // Two cohorts, deliberately both present: `harnesses` is every registered provider (the
    // catalog the config UI needs for per-provider file metadata), `machineHarnesses` is what this
    // machine actually has. Primary user-facing presentation must use the latter.
    harnesses: configSnapshotHarnesses(),
    machineHarnesses: configSnapshotMachineHarnesses(),
    packages,
    bundles,
    tools,
    permissions,
    plugins: {
      caveman: settings?.enabledPlugins?.["caveman@caveman"] === true,
    },
    // Harness-agnostic rules + global settings shown in the /config "Globals" section. Each rules
    // entry carries raw markdown plus rendered HTML: shared = baseline every harness gets, one key
    // per registered provider id = that harness's rule deltas, packages = enabled package rule
    // slices. The live home files are also included so the portal can render the actual on-disk
    // CLAUDE.md / AGENTS.md.
    globals: {
      rules: {
        shared: renderEntry(renderSharedRulesPreview()),
        ...Object.fromEntries(
          listHarnessProviders().map((provider) => [provider.id, renderEntry(renderHarnessRulesPreview(provider.id))]),
        ),
        packages: renderEntry(renderEnabledPackageRulesPreview()),
      },
      liveRules: Object.fromEntries(
        listHarnessProviders().map((provider) => [provider.id, readLiveRulesFile(provider.id)]),
      ),
      settings: {
        plugins: { caveman: settings?.enabledPlugins?.["caveman@caveman"] === true },
        hooks,
      },
    },
    // Root-config drift state per harness (in-sync / drifted / staged-pending / …), same signal the
    // terminal `roborepo config root inspect` reports. The portal renders a status chip from this.
    rootConfig: buildRootConfigView().map((row) => ({
      harness: row.harness,
      state: row.state,
      hasStagedUpdate: !!row.stagedUpdate,
    })),
    telemetry: telemetryState
      ? { enabled: !!telemetryState.enabled }
      : { enabled: false },
    onboarding: {
      libraryCompleted: !!presetState.onboardedAt,
    },
    settings: {
      hooks,
      permissions: {
        allow: (settings?.permissions?.allow || []).length,
        deny: (settings?.permissions?.deny || []).length,
      },
    },
  };
  // Token-cost estimates need the full catalog objects (rule sources, sourceFile), which the
  // presentation `packages` list strips — so this is computed here from availablePackages, not
  // rebuilt from the snapshot. Cached by stat signature, so polling stays cheap.
  snapshot.contextCost = buildContextCost({
    catalog: availablePackages,
    enabledIds: packages.filter((pkg) => pkg.enabled).map((pkg) => pkg.id),
    tools,
  });
  // Computed once here so terminal and web render from the identical view (no client-side fork).
  snapshot.behaviorView = buildBehaviorView(snapshot);
  return snapshot;
}

// Maps the raw technical snapshot onto user-facing behavior categories matching README § Global
// Behavior. SINGLE SOURCE OF TRUTH for both the terminal `roborepo config` view and the web /config
// page: the snapshot ships this under `behaviorView`, the web client renders it directly (no parallel
// JS reimplementation to drift). Items carry both terminal fields (hint) and web fields (toggle,
// inspect, urls, badges); each consumer reads what it needs and ignores the rest.
export function buildBehaviorView(snap) {
  const perms = snap.permissions;
  const categories = readPackageCategories();
  const byCategory = new Map(categories.map((category) => [category.id, { ...category, items: [] }]));
  const toolByPackage = new Map((snap.tools || []).map((tool) => [tool.packageId, tool]));
  const packageCosts = snap.contextCost?.packages || {};
  for (const item of snap.packages) {
    const section = byCategory.get(item.presentation?.category);
    if (!section) continue;
    section.items.push(packagePresentationItem(item, toolByPackage.get(item.id), packageCosts[item.id] || null));
  }

  const sections = categories
    .map((category) => byCategory.get(category.id))
    .filter((section) => section && section.items.length > 0)
    .map((section) => ({
      category: section.label,
      categoryId: section.id,
      // Opt-in section-level bulk toggle (portal-only affordance; the terminal view ignores it).
      bulkToggle: section.bulkToggle === true,
      // Section prose lives in the category manifest, not in each consumer's markup, so adding a
      // category needs no template edit in the portal or the CLI printer.
      description: section.description,
      footnote: section.footnote,
      items: section.items.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)),
      contextCost: sectionContextCost(section.items),
    }));

  const permItems = permissionItems(perms);
  return [
    ...sections,
    {
      category: "Permissions",
      kind: "permissions",
      // Group boundary for consumers: the first `customizedCount` items are the user's, the rest
      // are shipped defaults. Derived here so the portal and the CLI printer never re-derive
      // (and never disagree about) where the split falls.
      customizedCount: permItems.filter((it) => it.overridden).length,
      // Category taxonomy for the defaults list, manifest-ordered safest-to-riskiest. Only the
      // defaults are grouped: YOURS is usually one to three rows, where headings cost more than
      // they organize. Shipped as data so consumers render whatever the manifest defines rather
      // than carrying their own copy of the list.
      categories: permissionCategories(),
      // Permission entries are config syntax, not prompt text — never given a token number.
      contextCost: { label: "not-prompt-context" },
      // Section-level caveats about harnesses present on this machine (e.g. one with no
      // per-command ask tier). Empty when every installed harness supports the full model.
      notices: askTierNotices(),
      // Flat model: every permission entry — whether a named behavior (semantic, e.g. "git push")
      // or an arbitrary command (a literal token array, e.g. "npm test") — is independently
      // deny/ask/allow. No profile bundle, no project scope; global only.
      //
      // The list is NOT split by that semantic-vs-literal distinction: which kind an entry is, is
      // an implementation detail the person setting a permission does not care about. It is split
      // by whether THEY changed it — `yours` (customized, with a delete affordance) above
      // `defaults` (as shipped, collapsed behind a count). `kind` survives on each row because
      // consumers dispatch the right control off it (and presets.mjs's onboarding wizard selects
      // named behaviors by it), but it no longer decides grouping or order.
      //
      // `perms` (snap.permissions, from config-mutate.mjs effectivePermissions()) already merges
      // manifest defaults with personal overrides — this just reshapes it for display.
      items: permItems,
    },
    storesSection(),
  ];
}

// One merged permission list, ordered by whether the user customized the entry rather than by
// which internal kind it is. Named behaviors and arbitrary commands interleave freely.
//
// Within each group, rows keep the existing loosest-to-strictest bucket order (allow, ask, deny)
// and then sort by label, so a given entry sits in a stable place across renders.
//
// `deletable` is what the delete affordance means for a row, and it is NOT the same question as
// `overridden`:
//   - a customized named behavior reverts to its manifest default    -> "revert"
//   - an arbitrary command with defaultBucket "allow" is a manifest   -> "revert"
//     default the user re-bucketed, so it reverts too
//   - an arbitrary command with defaultBucket null was ADDED by the   -> "remove"
//     user; there is no default to fall back to, so delete drops it
// Every arbitrary command currently shipped is a manifest default, so the "remove" case has no
// live example — it is still reachable the moment someone adds a command, and must not regress.
const BUCKET_ORDER = { allow: 0, ask: 1, deny: 2 };

function permissionRowSort(a, b) {
  return (BUCKET_ORDER[a.bucket] ?? 99) - (BUCKET_ORDER[b.bucket] ?? 99)
    || a.label.localeCompare(b.label);
}

function permissionItems(perms) {
  const rows = [
    ...(perms?.behaviors || []).map((b) => ({
      id: b.id,
      label: b.label,
      description: b.description,
      active: true,
      kind: "behavior",
      bucket: b.bucket,
      overridden: b.overridden,
      defaultBucket: b.defaultBucket,
      // A named behavior always has a manifest default to fall back to, so its delete is a revert.
      deletable: b.overridden ? "revert" : null,
      category: b.category ?? null,
      // "go-online" has no Claude equivalent (Claude doesn't sandbox network); surfaced so the
      // UI can note it rather than silently implying parity across harnesses.
      codexOnly: !!b.codexOnly,
    })),
    ...(perms?.arbitrary || []).map((c) => ({
      id: c.id,
      label: c.label,
      active: true,
      kind: "arbitrary-item",
      // The mutate endpoint addresses arbitrary commands by token array, not by id.
      tokens: c.label.split(" "),
      bucket: c.bucket,
      overridden: c.overridden,
      defaultBucket: c.defaultBucket,
      deletable: c.overridden ? (c.defaultBucket ? "revert" : "remove") : null,
      category: c.category ?? null,
      noCodexAsk: c.bucket === "ask",
    })),
  ];

  return [
    ...rows.filter((r) => r.overridden).sort(permissionRowSort),
    ...rows.filter((r) => !r.overridden).sort(permissionRowSort),
  ];
}

// What roborepo is keeping on disk, and how close each store is to its bound. Read-only here:
// resetting is `roborepo maintenance stores reset <id>`, a destructive action that belongs behind
// an explicit command rather than a click in a config dashboard.
//
// Sizes are measured on read, so this is a live view rather than a cached one. Stores that do not
// exist yet report zero instead of being hidden — "nothing captured yet" is information.
function storesSection() {
  return {
    category: "Local Stores",
    kind: "stores",
    description: "Observability data roborepo keeps on disk. Each store trims itself on write.",
    // On-disk bytes, not prompt tokens — the same distinction the Permissions section draws.
    contextCost: { label: "not-prompt-context" },
    items: storeHealth().map((store) => ({
      id: store.id,
      label: store.id,
      kind: "store",
      path: store.path,
      bytes: store.bytes,
      maxBytes: store.maxBytes,
      over: store.over,
    })),
  };
}

// Active rollups only count enabled items; potential totals let the UI show what enabling the
// rest would add without mixing disabled cost into the primary number.
function sectionContextCost(items) {
  const totals = {
    activeStartupTokens: 0,
    activeOnDemandTokens: 0,
    potentialStartupTokens: 0,
    potentialOnDemandTokens: 0,
  };
  for (const item of items) {
    const cost = item.contextCost;
    if (!cost) continue;
    totals.activeStartupTokens += cost.activeStartupTokens || 0;
    totals.activeOnDemandTokens += cost.activeOnDemandTokens || 0;
    totals.potentialStartupTokens += cost.startupTokens || 0;
    totals.potentialOnDemandTokens += cost.onDemandTokens || 0;
  }
  return totals;
}

// True when a package's prose label is just its command spelled as words ("Session Close" / `session-close`),
// meaning the label adds nothing the command already says. Punctuation and case are stripped so
// "Case study skill" still reads as a restatement of `case-study`; a label carrying extra words the
// command lacks ("Token Telemetry" vs `telemetry-marker`) does not.
function labelRestatesCommand(label, command) {
  const normalize = (value) => String(value || "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
  const labelWords = new Set(normalize(label).split(" ").filter(Boolean));
  const commandWords = normalize(command).split(" ").filter(Boolean);
  if (labelWords.size === 0 || commandWords.length === 0) return false;
  // "skill"/"pack" are packaging nouns, not meaning: "Case study skill" is still just `/case-study`.
  for (const filler of ["skill", "skills", "pack", "package"]) labelWords.delete(filler);
  return [...labelWords].every((word) => commandWords.includes(word));
}

function packagePresentationItem(item, tool, contextCost = null) {
  const command = tool?.command || null;
  // Label a command-backed package by the command it exposes (`/session-close`) rather than its prose
  // label. Keyed on the package actually having a command, NOT on a category id: this previously
  // compared the category against a now-deleted id, and when that category was removed the
  // condition silently became unreachable, so every such package quietly lost its `/command` label.
  // scripts/test/package-catalog-check.mjs now fails on any category literal the manifest lacks.
  //
  // Having a command is necessary but not sufficient. A package whose prose label says something
  // the command does not is a product that happens to ship a command, not a command: `telemetry`
  // is "Token Telemetry" and exposes `/telemetry-marker`, and showing the command as its name hides
  // what the package actually is. Command-first packages all label themselves after their command
  // ("Session Close" for `/session-close`), so comparing the two normalized forms separates the cases without a
  // hand-maintained list -- a new command-first package needs no entry anywhere.
  const showCommandLabel = Boolean(command) && labelRestatesCommand(item.label, command);
  const resources = item.resources || item.components || [];
  const inspect = command
    ? {
        kind: "command-skill",
        id: command,
        skill: tool.id,
        harness: (tool.commandHarnesses || []).includes("claude") ? "claude" : (tool.commandHarnesses || [])[0] || "claude",
        label: `/${command}`,
      }
    : resources.includes("skill") && item.skillIds?.length
      ? { kind: "skill", id: item.skillIds[0], label: item.label }
      : resources.includes("rules")
        ? { kind: "rules", id: item.id, label: item.label }
        : null;
  return {
    id: item.id,
    label: showCommandLabel ? `/${command}` : item.label,
    description: item.description,
    order: item.presentation?.order || 0,
    active: item.enabled,
    toggle: "package",
    urls: item.urls || [],
    badges: [
      ...(item.catalogStatus === "pending" ? ["pending"] : []),
      ...(item.status && item.status !== "enabled" && item.status !== "disabled" ? [item.status] : []),
    ],
    resources,
    inspect,
    contextCost,
    hint: item.id === "telemetry" && (item.enabled || item.status === "configured") ? "roborepo web" : null,
  };
}

function hooksStorageOf(harness) {
  return getHarnessProvider(harness).manifest.extensions?.app?.hooksStorage;
}

// Generated build output for a sidecar-hooks provider's hooks file (e.g. generated/codex/hooks.json)
// — same "generated/<id>/<basename>" convention rootConfigBaseline uses for the root-config file,
// applied to the provider's declared "hooks" path instead.
function generatedSidecarHooksPath(harness) {
  const manifest = getHarnessProvider(harness).manifest;
  return path.join(repoRoot, "generated", harness, path.basename(manifest.paths.hooks.path));
}

// Read the full source that DEFINES a tool, for the /config click-to-inspect popup. Strictly
// whitelisted: kind+id are resolved against the catalogs/known dirs, never used to build a path
// directly, so an attacker can't request arbitrary files (no traversal — ids are matched against
// catalog entries and basenames only). Returns { ok, title, path, content } or { ok:false, error }.
const HARNESS_SCOPED_KINDS = new Set(["command", "command-skill", "globals-rules", "harness-hooks", "live-rules"]);

export function loadConfigSource({ kind, id, harness = "claude" }) {
  const fail = (error) => ({ ok: false, error });
  // Only kinds that read a harness-specific file need the id validated — config-file/skill kinds
  // resolve the harness from `id` itself, so a missing/default harness there is never a bug.
  if (HARNESS_SCOPED_KINDS.has(kind) && !hasHarnessProvider(harness)) {
    return fail(`missing or unknown harness: ${harness ?? "(none)"}`);
  }
  const harnessSafe = harness;

  if (kind === "skill") {
    if (!packageSkillIds().has(id)) return fail(`unknown skill: ${id}`);
    const source = skillInventorySource(id);
    if (!source.ok) return fail(source.error);
    return readSkillSource(source.item.inspectPath, `skill: ${id}`, source.item);
  }

  if (kind === "command") {
    const cmd = packageSlashCommands().find((c) => c.name === id);
    if (!cmd) return fail(`unknown command: ${id}`);
    const abs = path.join(repoRoot, "generated", "packages", cmd.packageId, harnessSafe, "commands", `${id}.md`);
    return readSourceFile(abs, `/${id} (${harnessSafe})`);
  }

  if (kind === "command-skill") {
    // id is the command NAME (no slash). Read both the generated command wrapper and the SKILL.md
    // it points at, so the popup shows the loading instruction plus the actual skill content.
    const cmd = packageSlashCommands().find((c) => c.name === id);
    if (!cmd) return fail(`unknown command: ${id}`);
    if (!cmd.skill || !packageSkillIds().has(cmd.skill)) return fail(`unknown skill for command: ${id}`);

    const commandAbs = path.join(repoRoot, "generated", "packages", cmd.packageId, harnessSafe, "commands", `${id}.md`);
    const command = readSourceFile(commandAbs, `/${id} (${harnessSafe})`);
    if (!command.ok) return command;
    const inventorySource = skillInventorySource(cmd.skill);
    if (!inventorySource.ok) return fail(inventorySource.error);
    const skill = readSkillSource(inventorySource.item.inspectPath, `skill: ${cmd.skill}`, inventorySource.item);
    if (!skill.ok) return skill;
    const skillParts = [
      renderCommandSourceHtml(`/${id} (${harnessSafe})`, command.content),
      skill.html,
    ].join("\n");
    return {
      ok: true,
      title: `/${id} + ${cmd.skill}`,
      path: `${command.path} + ${skill.path}`,
      paths: [command.path, skill.path],
      content: [
        `# /${id} (${harnessSafe})`,
        command.content.trimEnd(),
        "",
        `# skill: ${cmd.skill}`,
        skill.content.trimEnd(),
        "",
      ].join("\n"),
      html: skillParts,
    };
  }

  if (kind === "globals-rules") {
    // Full rendered home-rules for one harness (what lands in CLAUDE.md / AGENTS.md). Served on
    // demand so the 10s config poll doesn't carry ~13KB of rules text it rarely needs.
    const content = renderRulesPreview(harnessSafe);
    const file = getHarnessProvider(harnessSafe).manifest.paths.rules.path;
    return { ok: true, title: `Rendered rules — ${harnessSafe}`, path: file, content, html: renderMarkdown(content) };
  }

  if (kind === "harness-hooks") {
    const displayName = getHarnessProvider(harnessSafe).manifest.displayName;
    if (hooksStorageOf(harnessSafe) === "dedicated-json-sidecar") {
      const abs = generatedSidecarHooksPath(harnessSafe);
      const source = readSourceFile(abs, `${displayName} hooks`);
      if (!source.ok) return source;
      return { ...source, html: renderMarkdown("```json\n" + source.content.trimEnd() + "\n```") };
    }

    const abs = rootConfigBaseline[harnessSafe];
    const source = readSourceFile(abs, `${displayName} hooks`);
    if (!source.ok) return source;
    const settings = readJson(abs, {});
    const content = JSON.stringify(settings.hooks || {}, null, 2) + "\n";
    return {
      ok: true,
      title: `${displayName} hooks`,
      path: `${source.path}#hooks`,
      content,
      html: renderMarkdown("```json\n" + content + "```"),
    };
  }

  if (kind === "config-file") {
    for (const provider of listHarnessProviders()) {
      if (id === `${provider.id}-settings`) {
        const displayName = provider.manifest.displayName;
        const language = provider.manifest.extensions?.app?.rootConfigFormat || "json";
        return readExternalSourceFile(rootConfigActive[provider.id], `${displayName} settings`, provider.manifest.paths.rootConfig.path, language);
      }
      if (id === `${provider.id}-hooks` && hooksStorageOf(provider.id) === "dedicated-json-sidecar") {
        const displayName = provider.manifest.displayName;
        return readExternalSourceFile(resolveHarnessPath(provider.manifest, "hooks"), `${displayName} hooks`, provider.manifest.paths.hooks.path, "json");
      }
    }
    return fail(`unknown config file: ${id}`);
  }

  if (kind === "live-rules") {
    const live = readLiveRulesFile(harnessSafe);
    if (!live.installed && !live.content) return fail(`live rules file not found: ${harnessSafe}`);
    const file = getHarnessProvider(harnessSafe).manifest.paths.rules.path;
    return { ok: true, title: `Live rules — ${harnessSafe}`, path: file, content: live.content, html: live.html };
  }

  if (kind === "rules" || kind === "hooks") {
    // Resolve the package's component source from the catalog — never trust a caller-supplied path.
    const pkgs = loadPackageCatalog();
    const pkg = pkgs.find((p) => p.id === id);
    if (!pkg) return fail(`unknown package: ${id}`);
    const comp = pkg.components.find((c) => c.type === kind);
    if (!comp?.source) return fail(`package ${id} has no ${kind} source`);
    const abs = path.join(repoRoot, comp.source);
    return readSourceFile(abs, `${pkg.label} — ${kind}`);
  }

  return fail(`unknown kind: ${kind}`);
}

export function configCommand(args) {
  const [sub = "status", ...rest] = args;
  if (sub === "root") {
    const [rootSub] = rest;
    if (rootSub !== "inspect") {
      console.error("usage: roborepo config root inspect");
      process.exit(2);
    }
    return configRootInspect();
  }
  if (sub !== "status") {
    console.error("usage: roborepo config status");
    process.exit(2);
  }

  const snap = readConfigSnapshot();
  printConfigStatus(buildBehaviorView(snap));
}
