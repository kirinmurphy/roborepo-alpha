// Discovered-routes dropdown content: a portal-menu-button (portal/shared/menu-button.js) mounted
// per-card by app.js shows this as its panel. Not a dialog — see index.html's routes-trigger slot
// comment for why this moved off the three-dot menu.
//
// Two sections, because the two kinds of discovery answer different questions. A sitemap/manifest
// path is a PAGE — something you open, so it is a link and it opens in a new tab. An OpenAPI entry
// is an API ROUTE — most require a method, a body, or auth, so opening one in a browser yields a
// 404/405/JSON blob rather than anything useful. Those get a contract panel and a runnable curl
// instead of a link that lies about being clickable.
//
// Pages sort first: they are the ones you can act on immediately.
//
// Kept out of app.js for the same reason history-view.js is: app.js is already long, and this is a
// self-contained render concern.

import { portalFillSlots as fill, portalTpl as tpl } from "/portal/shared/api.js";
import { fetchMetadata } from "./api.js";
import { mergeSavedLinks } from "./routes-model.js";
export { fillApiRouteDialog } from "./api-route-dialog.js";

// Source and saved-state are two different facts, and this column reports only the first: where the
// path came from. Saving a discovered route does not change where it came from, so a /tokens found
// in the sitemap stays "Sitemap" after you click it and gets a checkmark instead — previously it
// came back relabeled "User Added", which erased its real origin and made a discovered route
// indistinguishable from one typed by hand.
//
// "User Added" therefore means exactly one thing: a link the user authored that no discovery source
// reported.
const SOURCE_LABELS = {
  openapi: "OpenAPI",
  sitemap: "Sitemap",
  manifest: "Manifest",
  robots: "Robots",
  user: "User Added",
};

// captureLink(project, instance, suggestion) must return the mutation's result (or throw) — same
// contract updateLinks already has. isSaved(project, instance, path) tells a row whether to show the
// checkmark, decided by the caller (app.js) since it owns lastSnapshot/currentLinks, not this view.
export async function buildRoutesDropdown(project, instance, {
  onStale,
  captureLink,
  isSaved,
  onOpenApiRoute,
  // User-added links for this app, as [{ id, label, path }], plus the actions that maintain them.
  // Supplied by app.js, which owns lastSnapshot and the mutation calls.
  userLinks = [],
  onAddLink,
  onEditLink,
  onDeleteLink,
} = {}) {
  let result;
  try {
    result = await fetchMetadata(instance.opaqueKey);
  } catch {
    return message("Suggestions are unavailable right now.");
  }

  // A 404 means the key went stale — the app's port changed since this snapshot was rendered.
  if (result?.ok === false) {
    onStale?.();
    return message("This app's port changed — reloading…");
  }

  const suggestions = result?.suggestions || [];

  // `kind` is set by the backend (modules/developer-runtime/metadata.mjs). Falling back on its absence
  // keeps this working against a cached snapshot minted before that field existed.
  const discoveredPages = suggestions.filter((s) => (s.kind || "page") === "page");
  const discoveredApis = suggestions.filter((s) => s.kind === "api");

  const { pages, apis } = mergeSavedLinks(discoveredPages, discoveredApis, userLinks);

  // A discovered-only panel (a promoted Compose container, which cannot hold saved links) has no Add
  // to fall back on, so an empty discovery would otherwise open onto a blank panel.
  if (!pages.length && !apis.length && !onAddLink) {
    return message("No pages or API routes discovered for this app.");
  }

  // The panel now has a reason to exist even with nothing discovered: it is where links are added.
  const list = document.createElement("div");
  list.className = "routes-dropdown-list";
  if (pages.length || onAddLink) {
    list.append(sectionHeading("Pages", onAddLink ? () => onAddLink(project, instance) : null));
    for (const suggestion of pages) {
      list.append(routeLinkRow(project, instance, suggestion, {
        captureLink,
        isSaved,
        onEditLink,
        onDeleteLink,
      }));
    }
    if (!pages.length) list.append(message("No pages yet."));
  }
  if (apis.length) {
    list.append(sectionHeading("API Routes"));
    for (const suggestion of apis) {
      list.append(apiRouteRow(instance, suggestion, onOpenApiRoute));
    }
  }
  return list;
}

// `onAction` mounts the heading's right-aligned button (currently "+ Add" on Pages). Absent for
// headings that have no action, which keeps the button out of the DOM rather than disabled.
function sectionHeading(text, onAction = null) {
  const heading = fill(tpl("tpl-routes-section-heading"), { title: text });
  const action = heading.querySelector("[data-slot=action]");
  if (onAction) {
    action.hidden = false;
    action.addEventListener("click", (event) => {
      // The panel stays open behind the add dialog: the dialog is about the list you are looking
      // at, and closing the thing you are editing to edit it loses that context.
      event.preventDefault();
      event.stopPropagation();
      onAction();
    });
  }
  return heading;
}

// Capture-on-click, not capture-on-open: opening the dropdown never mutates anything, only actually
// using a link does — and only once. A route already in app.links (isSaved) is a pure navigation,
// no mutation call at all, so re-clicking a saved link never risks a stale-revision 409 for
// something that's already true.
function routeLinkRow(project, instance, suggestion, { captureLink, isSaved, onEditLink, onDeleteLink }) {
  // Saved-ness is a property of the row, not of its source: a Sitemap route the user saved is as
  // editable as one they typed. `linkId` is what the edit/delete mutations need, so a row offers
  // them exactly when it has one.
  const saved = suggestion.saved || (isSaved?.(project, instance, suggestion.path) ?? false);
  const isSavedLink = Boolean(suggestion.linkId);
  const row = fill(tpl("tpl-route-link-row"), {
    source: SOURCE_LABELS[suggestion.source] || suggestion.source,
    // A saved link's own label is the name the user gave it; an unsaved one has only its path.
    path: suggestion.label || suggestion.path,
    href: { href: suggestion.path.startsWith("/") ? `${instance.origin || ""}${suggestion.path}` : suggestion.path },
  });
  const check = row.querySelector("[data-slot=saved-check]");
  if (check) check.hidden = !saved || isSavedLink;

  // Edit/delete take the checkmark's place on a saved link — see the template's note on why the two
  // are mutually exclusive.
  if (isSavedLink) {
    const actions = row.querySelector("[data-slot=row-actions]");
    if (actions) actions.hidden = !onEditLink && !onDeleteLink;
    // Both sit inside the row's anchor, so each must stop the click from also navigating.
    row.querySelector("[data-action=edit-link]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onEditLink?.(project, instance, suggestion.linkId);
    });
    row.querySelector("[data-action=delete-link]")?.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      onDeleteLink?.(project, instance, suggestion.linkId);
    });
    return row;
  }

  if (!saved) {
    row.addEventListener("click", () => {
      // Fire-and-forget: the link opens via the anchor's own default behavior regardless of
      // whether the capture succeeds, since a failed save should never block navigation to a route
      // the user already confirmed they want by clicking it.
      Promise.resolve(captureLink?.(project, instance, suggestion)).then(() => {
        if (check) check.hidden = false;
      }).catch(() => {});
    });
  }
  return row;
}

// An API route is described, not navigated to. The row is a button that opens the contract modal —
// see fillApiRouteDialog, which app.js wires to #api-route-dialog.
function apiRouteRow(instance, suggestion, onOpenApiRoute) {
  const row = fill(tpl("tpl-route-api-row"), {
    method: suggestion.method || "GET",
    path: suggestion.path,
  });
  row.querySelector("[data-slot=method]").dataset.method = (suggestion.method || "GET").toLowerCase();
  // A saved API route lives only here now, never as a duplicate Page row, so this is the one place
  // its saved state can be shown.
  const check = row.querySelector("[data-slot=saved-check]");
  if (check) check.hidden = !suggestion.saved;
  row.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onOpenApiRoute?.(instance, suggestion);
  });
  return row;
}

function message(text) {
  const p = document.createElement("p");
  p.className = "no-links";
  p.textContent = text;
  return p;
}
