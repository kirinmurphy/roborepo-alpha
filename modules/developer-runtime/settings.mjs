import fs from "node:fs";
import path from "node:path";
import { randomUUID } from "node:crypto";
import {
  DEFAULT_PREFERENCES,
  LEGACY_SETTINGS_VERSION,
  SETTINGS_VERSION,
  assertAliasGraph,
  defaultSettings,
  labelFromId,
  normalizeHealth,
  normalizeMatch,
  normalizeRoutePath,
  resolveProjectAlias,
  safeBoolean,
  safeId,
  safeIdentity,
  safeLabel,
  slugify,
  validateLegacySettings,
  validateSettings,
} from "./settings-schema.mjs";
import { safeAbsolutePath } from "../repositories/schema.mjs";

export {
  SETTINGS_VERSION,
  defaultSettings,
  normalizeRoutePath,
  resolveProjectAlias,
  validateSettings,
};

export function settingsPathFor(stateRoot) {
  return path.join(stateRoot, "developer-runtime", "settings.json");
}

export function loadSettings({ stateRoot, fsApi = fs } = {}) {
  const filePath = settingsPathFor(stateRoot);
  try {
    const parsed = JSON.parse(fsApi.readFileSync(filePath, "utf8"));
    const migrated = migrateSettings(parsed);
    if (parsed.version !== SETTINGS_VERSION) {
      backupSettingsFile(filePath, parsed.version, fsApi);
      writeSettings({ stateRoot, settings: migrated, fsApi });
    }
    return validateSettings(migrated);
  } catch (err) {
    if (err && err.code === "ENOENT") return defaultSettings();
    if (err instanceof SyntaxError) throw new Error("developer-runtime settings contain malformed JSON");
    throw err;
  }
}

export function writeSettings({ stateRoot, settings, fsApi = fs } = {}) {
  const filePath = settingsPathFor(stateRoot);
  const dir = path.dirname(filePath);
  fsApi.mkdirSync(dir, { recursive: true });
  const temp = path.join(dir, `.settings.${process.pid}.${Date.now()}.tmp`);
  fsApi.writeFileSync(temp, `${JSON.stringify(validateSettings(settings), null, 2)}\n`);
  fsApi.renameSync(temp, filePath);
  return settings;
}

export function updateSettings({ stateRoot, input, fsApi = fs } = {}) {
  const current = loadSettings({ stateRoot, fsApi });
  if (!input || input.revision !== current.revision) {
    const error = new Error("developer-runtime settings revision conflict");
    error.code = "REVISION_CONFLICT";
    error.current = current;
    throw error;
  }

  const next = cloneJson(current);
  applyMutation(next, input);
  next.revision += 1;
  writeSettings({ stateRoot, settings: next, fsApi });
  return next;
}

function applyMutation(settings, input) {
  if (input.type === "project") return mutateProject(settings, input);
  if (input.type === "links") return mutateLinks(settings, input);
  if (input.type === "association") return mutateAssociation(settings, input);
  if (input.type === "alias") return mutateAlias(settings, input);
  if (input.type === "composeProject") return mutateComposeProject(settings, input);
  if (input.type === "preferences") {
    if (!Number.isInteger(input.worktreeStaleDays) || input.worktreeStaleDays < 1 || input.worktreeStaleDays > 365) throw new Error("worktreeStaleDays must be between 1 and 365");
    settings.preferences.worktreeStaleDays = input.worktreeStaleDays;
    return;
  }
  throw new Error("unknown developer-runtime settings mutation");
}

function mutateProject(settings, input) {
  const project = ensureProject(settings, input.projectIdentity);
  if (input.name != null) project.name = safeLabel(input.name, "project name");
  if (input.favorite != null) project.favorite = safeBoolean(input.favorite, "project favorite");
  if (input.hidden != null) project.hidden = safeBoolean(input.hidden, "project hidden");
  if (input.appId) {
    const app = ensureApp(project, input.appId);
    if (input.appName != null) app.name = safeLabel(input.appName, "app name");
    if (input.appFavorite != null) app.favorite = safeBoolean(input.appFavorite, "app favorite");
    if (input.appHidden != null) app.hidden = safeBoolean(input.appHidden, "app hidden");
    if (input.health != null) app.health = normalizeHealth(input.health);
    if (input.match != null) app.match = normalizeMatch(input.match);
    if (input.originPreference != null) {
      if (!["localhost", "127.0.0.1", "::1"].includes(input.originPreference)) throw new Error("invalid origin preference");
      app.originPreference = input.originPreference;
    }
  }
}

function mutateLinks(settings, input) {
  const project = ensureProject(settings, input.projectIdentity);
  const app = ensureApp(project, input.appId || "web");
  if (!Array.isArray(input.links)) throw new Error("links mutation requires links array");
  const seen = new Set();
  app.links = input.links.map((link) => {
    const id = safeId(link.id || slugify(link.label) || randomUUID());
    if (seen.has(id)) throw new Error(`duplicate link id: ${id}`);
    seen.add(id);
    return { id, label: safeLabel(link.label, "link label"), path: normalizeRoutePath(link.path) };
  });
}

function mutateAssociation(settings, input) {
  const key = safeId(input.associationKey);
  if (input.remove) {
    delete settings.associations[key];
    return;
  }
  settings.associations[key] = {
    projectIdentity: safeIdentity(input.projectIdentity),
    appId: safeId(input.appId || "web"),
  };
}

// Keyed by the raw Docker Compose project name (e.g. "trpc_starter"), not a listener-derived
// associationKey — a Compose project is one operation spanning several containers/ports, and
// there is no single listener to key it off of the way per-app associations are. repoIdentity is
// the "assign the spawning repo to this project" link: once set, the compose card's git badge and
// info tooltip resolve git context from that repo instead of showing nothing (Docker containers
// have no cwd of their own for the existing git-by-cwd resolution to work from).
function mutateComposeProject(settings, input) {
  settings.composeProjects ||= {};
  const name = input.composeProject;
  if (typeof name !== "string" || !name.trim()) throw new Error("composeProject mutation requires composeProject name");
  if (input.remove) {
    delete settings.composeProjects[name];
    return;
  }
  const current = settings.composeProjects[name] || {};
  const next = { ...current };
  if (input.name != null) next.name = safeLabel(input.name, "compose project name");
  if (input.favorite != null) next.favorite = safeBoolean(input.favorite, "compose project favorite");
  if (input.hidden != null) next.hidden = safeBoolean(input.hidden, "compose project hidden");
  if (input.repoPath != null) next.repoPath = input.repoPath === "" ? undefined : safeAbsolutePath(input.repoPath, "compose project repoPath");
  settings.composeProjects[name] = next;
}

function mutateAlias(settings, input) {
  const from = safeIdentity(input.from);
  if (input.remove) {
    delete settings.aliases[from];
    return;
  }
  if (input.confirmed !== true) throw new Error("alias mutation requires confirmation");
  const to = safeIdentity(input.to);
  if (from === to) throw new Error("alias cannot point to itself");
  const nextAliases = { ...settings.aliases, [from]: to };
  assertAliasGraph(nextAliases);
  mergeAliasedProject(settings, from, to);
  repointAssociations(settings, from, to);
  settings.aliases[from] = to;
}

function migrateSettings(settings) {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) throw new Error("settings must be an object");
  // composeProjects is new within SETTINGS_VERSION 2 itself (added after the initial v2 rollout),
  // so an on-disk v2 file from before this field existed still needs a default backfilled here —
  // a version bump alone wouldn't have caught it since migrateSettings only branches on version.
  if (settings.version === SETTINGS_VERSION) return validateSettings({ composeProjects: {}, ...settings });
  if (settings.version !== LEGACY_SETTINGS_VERSION) throw new Error(`unsupported developer-runtime settings version: ${settings.version}`);
  validateLegacySettings(settings);
  return validateSettings({
    version: SETTINGS_VERSION,
    revision: settings.revision,
    projects: Object.fromEntries(Object.entries(settings.projects).map(([identity, project]) => [identity, migrateProject(project)])),
    associations: { ...settings.associations },
    aliases: {},
    composeProjects: {},
    preferences: { ...DEFAULT_PREFERENCES },
  });
}

function migrateProject(project) {
  return {
    ...project,
    favorite: project.favorite === true,
    hidden: project.hidden === true,
    apps: Object.fromEntries(Object.entries(project.apps).map(([appId, app]) => [appId, migrateApp(app)])),
  };
}

function migrateApp(app) {
  return {
    ...app,
    favorite: app.favorite === true,
    hidden: app.hidden === true,
  };
}

function backupSettingsFile(filePath, version, fsApi) {
  const backupPath = path.join(path.dirname(filePath), `settings.v${version}.backup.json`);
  if (fsApi.existsSync?.(backupPath)) return;
  fsApi.copyFileSync(filePath, backupPath);
}

function mergeAliasedProject(settings, from, to) {
  const source = settings.projects[from];
  if (!source) return;
  const target = settings.projects[to];
  if (!target) {
    settings.projects[to] = source;
    delete settings.projects[from];
    return;
  }
  mergeProjectSettings(target, source);
  delete settings.projects[from];
}

function mergeProjectSettings(target, source) {
  target.name ||= source.name;
  target.favorite = target.favorite === true || source.favorite === true;
  target.hidden = target.hidden === true || source.hidden === true;
  target.apps ||= {};
  for (const [appId, sourceApp] of Object.entries(source.apps || {})) {
    if (!target.apps[appId]) {
      target.apps[appId] = sourceApp;
      continue;
    }
    mergeAppSettings(target.apps[appId], sourceApp, appId);
  }
}

function mergeAppSettings(target, source, appId) {
  target.name ||= source.name;
  target.favorite = target.favorite === true || source.favorite === true;
  target.hidden = target.hidden === true || source.hidden === true;
  target.originPreference ||= source.originPreference;
  target.health = mergeOptionalObject(target.health, source.health, `app ${appId} health`);
  target.match = mergeOptionalObject(target.match, source.match, `app ${appId} match`);
  target.links = mergeLinks(target.links || [], source.links || [], appId);
}

function mergeOptionalObject(target, source, label) {
  if (target == null) return source == null ? undefined : cloneJson(source);
  if (source == null) return target;
  if (JSON.stringify(target) !== JSON.stringify(source)) throw new Error(`alias merge conflict for ${label}`);
  return target;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function mergeLinks(targetLinks, sourceLinks, appId) {
  const links = [...targetLinks];
  const byId = new Map(links.map((link) => [link.id, link]));
  for (const link of sourceLinks) {
    const existing = byId.get(link.id);
    if (!existing) {
      links.push(link);
      byId.set(link.id, link);
      continue;
    }
    if (existing.label !== link.label || existing.path !== link.path) throw new Error(`alias merge link id collision for ${appId}: ${link.id}`);
  }
  return links;
}

function repointAssociations(settings, from, to) {
  for (const association of Object.values(settings.associations)) {
    if (association.projectIdentity === from) association.projectIdentity = to;
  }
}

function ensureProject(settings, identity) {
  const key = safeIdentity(identity);
  settings.projects[key] ||= { favorite: false, hidden: false, apps: {} };
  settings.projects[key].apps ||= {};
  settings.projects[key].favorite ||= false;
  settings.projects[key].hidden ||= false;
  return settings.projects[key];
}

function ensureApp(project, appId) {
  const key = safeId(appId);
  project.apps[key] ||= { name: labelFromId(key), favorite: false, hidden: false, originPreference: "localhost", links: [] };
  project.apps[key].links ||= [];
  project.apps[key].favorite ||= false;
  project.apps[key].hidden ||= false;
  return project.apps[key];
}
