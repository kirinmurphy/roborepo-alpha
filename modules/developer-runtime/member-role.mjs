// What a running member is for, and which one a checkout row should link to. Pure functions over the
// instance record, so the snapshot builder decides and the portal only renders the result.
//
// Roles, in the order a checkout ranks them:
//   app      pages a user of the product would visit — the only role that can be promoted
//   tooling  human-readable developer tooling (Storybook, Studio, Mailpit)
//   api      answers HTTP but serves no page
//   service  databases, caches, sockets — anything that does not answer HTTP, or is named like it

import { APP_LIKE_NAMES, COMMON_APP_PORTS, SERVICE_PRESETS, TOOLING_PRESETS } from "./member-role-presets.mjs";

export const MEMBER_ROLES = Object.freeze(["app", "tooling", "api", "service"]);

export function classifyMemberRole(instance) {
  if (!answeredHttp(instance)) return "service";
  const tokens = nameTokens(instance);
  const port = instance.bind?.port;
  if (matchesAny(tokens, SERVICE_PRESETS.names) || SERVICE_PRESETS.ports.includes(port)) return "service";
  const title = (instance.title || "").toLowerCase();
  if (
    matchesAny(tokens, TOOLING_PRESETS.names)
    || TOOLING_PRESETS.ports.includes(port)
    || TOOLING_PRESETS.titles.some((preset) => title.includes(preset))
  ) {
    return "tooling";
  }
  if (instance.title) return "app";
  // An app shell that sets its title from JavaScript still answers 2xx HTML. Error pages and
  // redirects do not count: neither is the page a person came to open.
  return isSuccess(instance.status) && isHtml(instance.contentType) ? "app" : "api";
}

// Orders items shaped `{ role, instance }` — a member, or a Compose container instance wrapped the
// same way — by role, then by the tie-breakers below. The repository name is context rather than a
// field of either item, which is why this is a factory.
export function createRoleComparator({ repositoryName = "" } = {}) {
  const repository = repositoryName.trim().toLowerCase();
  return (a, b) =>
    roleRank(a.role) - roleRank(b.role)
    || preferTrue(hasTitle(a), hasTitle(b))
    || preferTrue(titleNamesRepository(a, repository), titleNamesRepository(b, repository))
    || preferTrue(hasAppLikeName(a), hasAppLikeName(b))
    || preferTrue(onCommonAppPort(a), onCommonAppPort(b))
    || preferTrue(Boolean(a.instance?.origin?.startsWith("https:")), Boolean(b.instance?.origin?.startsWith("https:")))
    || portOf(a) - portOf(b);
}

// A trust failure is the one answer with no status: the server spoke TLS, the certificate was just
// not trusted, so it is an HTTP endpoint rather than a socket.
function answeredHttp(instance) {
  return instance.status != null || instance.tls === "untrusted";
}

// Every name the record carries, split into lowercase whole tokens: the user's app name, the process
// command, the Compose service, and the container name (`supabase_db_menugoats` -> supabase, db,
// menugoats). Splitting is what lets a Supabase CLI container match `db` without a service label.
function nameTokens(instance) {
  const names = [instance.app?.name, instance.process?.command, instance.docker?.composeService, instance.docker?.name];
  return names
    .filter((name) => typeof name === "string" && name)
    .flatMap((name) => name.toLowerCase().split(/[\s_.-]+/))
    .filter(Boolean);
}

function matchesAny(tokens, presets) {
  return tokens.some((token) => presets.includes(token));
}

function isSuccess(status) {
  return typeof status === "number" && status >= 200 && status < 300;
}

function isHtml(contentType) {
  return typeof contentType === "string" && contentType.toLowerCase().startsWith("text/html");
}

function roleRank(role) {
  const index = MEMBER_ROLES.indexOf(role);
  return index === -1 ? MEMBER_ROLES.length : index;
}

// -1 when only `a` holds the property, so it sorts first; 0 when both or neither do.
function preferTrue(a, b) {
  return a === b ? 0 : a ? -1 : 1;
}

function hasTitle(item) {
  return Boolean(item.instance?.title);
}

function titleNamesRepository(item, repository) {
  return Boolean(repository) && (item.instance?.title || "").toLowerCase().includes(repository);
}

function hasAppLikeName(item) {
  return matchesAny(nameTokens(item.instance || {}), APP_LIKE_NAMES);
}

function onCommonAppPort(item) {
  return COMMON_APP_PORTS.includes(portOf(item));
}

function portOf(item) {
  return item.instance?.bind?.port ?? Number.MAX_SAFE_INTEGER;
}
