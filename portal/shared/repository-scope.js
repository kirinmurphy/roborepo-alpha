// The Portal-wide repository scope in the URL: `?repo=<urlKey>`, shared by every page whose
// manifest entry sets `repositoryScope` (Plans, Tokens, Agents). This module owns parsing,
// composing, and clearing that one parameter, and tells the page when it changes; pages keep their
// own parameters (Plans' `lifecycle`) untouched.
//
//   onRepositoryScopeChange((scope) => refetch());   // after the selector, Clear, or back/forward
//   setRepositoryScope("roborepo");                 // pushes the URL, then notifies
//   setRepositoryScopeGuard({ isDirty, confirm });  // lets a page hold a change it has work to save
//   scopedPagePath(page);                           // a nav href that keeps or drops the scope
//
// No imports and no top-level DOM access beyond the guarded popstate listener, so the pure helpers
// load in Node checks as well as in the browser.

export const REPOSITORY_SCOPE_PARAM = "repo";
// Activity outside listed repos (Tokens only). Mirrors OUTSIDE_ACTIVITY_SCOPE in
// modules/repositories/scope.mjs; `_` cannot appear in a urlKey, so it never names a repository.
export const OUTSIDE_ACTIVITY_SCOPE = "_other";
// The error code a scoped data route answers with for a malformed, unknown, or hidden key.
export const REPOSITORY_SCOPE_UNAVAILABLE = "REPOSITORY_SCOPE_UNAVAILABLE";
const CHANGE_EVENT = "portal:repositoryscopechange";

// The scope a query string names, or null for All repositories.
export function repositoryScopeFromSearch(search) {
  return new URLSearchParams(search).get(REPOSITORY_SCOPE_PARAM) || null;
}

export function currentRepositoryScope() {
  return repositoryScopeFromSearch(location.search);
}

// `href` with only the `repo` parameter set to `scope` (removed when scope is null); every
// other parameter and the hash stay as they were. Returns a path, never an absolute URL.
export function hrefWithRepositoryScope(href, scope) {
  const url = new URL(href, "http://portal.invalid");
  if (scope) url.searchParams.set(REPOSITORY_SCOPE_PARAM, scope);
  else url.searchParams.delete(REPOSITORY_SCOPE_PARAM);
  return `${url.pathname}${url.search}${url.hash}`;
}

// The href for a nav link to `page` (a manifest entry). The scope travels only to scope-aware
// pages, and Activity outside listed repos only to a page that offers it; a link never carries
// another page's own parameters.
export function scopedPagePath(page, scope) {
  if (!scope || !page.repositoryScope) return page.path;
  if (scope === OUTSIDE_ACTIVITY_SCOPE && !page.outsideActivityScope) return page.path;
  return hrefWithRepositoryScope(page.path, scope);
}

// An API path with the current scope added, for a scoped page's own data requests.
export function withRepositoryScope(apiPath, scope = currentRepositoryScope()) {
  return scope ? hrefWithRepositoryScope(apiPath, scope) : apiPath;
}

export function isRepositoryScopeUnavailable(error) {
  return error?.code === REPOSITORY_SCOPE_UNAVAILABLE;
}

// Changing the scope pushes a history entry instead of navigating, so in-memory page state (Plans
// filters, say) survives; the page refetches from its change listener. The scoped page starts from
// the top, as a new page would; back/forward skip this and keep the browser's scroll restoration.
export function setRepositoryScope(scope) {
  if ((scope || null) === currentRepositoryScope()) return;
  if (guard?.isDirty()) {
    guard.confirm(() => applyScope(scope));
    return;
  }
  applyScope(scope);
}

function applyScope(scope) {
  history.pushState(null, "", hrefWithRepositoryScope(location.href, scope));
  window.scrollTo(0, 0);
  notifyIfChanged("push");
}

// A page with unsaved work can hold scope changes: while `isDirty()` is true, a change waits for
// `confirm(proceed)`, and back/forward leaves the scope alone until the page calls
// syncRepositoryScopeFromUrl, because the browser has already moved the URL and only the page knows
// whether it will stay there.
export function setRepositoryScopeGuard(value) {
  guard = value;
}

export function syncRepositoryScopeFromUrl() {
  notifyIfChanged();
}

export function clearRepositoryScope() {
  setRepositoryScope(null);
}

// `source` is "push" when this page chose the scope, "history" for back/forward. A pushed scope is a
// new place, so a page drops its own position parameters; history already restored them.
export function onRepositoryScopeChange(listener) {
  window.addEventListener(CHANGE_EVENT, (event) => listener(event.detail.scope, { source: event.detail.source }));
}

let lastScope = typeof location === "undefined" ? null : currentRepositoryScope();
let guard = null;

function notifyIfChanged(source = "history") {
  const scope = currentRepositoryScope();
  if (scope === lastScope) return;
  lastScope = scope;
  window.dispatchEvent(new CustomEvent(CHANGE_EVENT, { detail: { scope, source } }));
}

// Back/forward restores the scope with everything else in the URL.
if (typeof window !== "undefined") {
  window.addEventListener("popstate", () => {
    if (!guard?.isDirty()) notifyIfChanged();
  });
}
