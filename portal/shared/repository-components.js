// Shared repository/workspace primitives. The pages own their surrounding markup and unique
// slots, while this module keeps the repeated identity and action affordances consistent.

// The repository detail page is parked: names render as plain text, and the server redirects
// /repositories/* to Home (the route's `redirect` in portal-server.mjs). Restore the URL below to
// bring the page back.
export function repositoryPageUrl(_repository) {
  return null;
}

export function configureRepositoryName(node, { name, href }) {
  const slot = node.querySelector("[data-slot=repository-name]");
  if (!slot) return;
  if (href) {
    slot.href = href;
    slot.textContent = name || "Repository";
  } else {
    // Unlinked names keep the linked name's face (mono, via .repository-name-text) so a card looks
    // the same with or without a detail page to point at.
    const text = document.createElement("span");
    text.className = "repository-name-text";
    text.textContent = name || "Repository";
    slot.replaceWith(text);
  }
}

export function configureProviderLink(node, providerUrl, label = "GitHub") {
  const link = node.querySelector("[data-slot=provider-link]");
  if (!link) return;
  if (!providerUrl) {
    link.remove();
    return;
  }
  link.hidden = false;
  link.href = providerUrl;
  link.target = "_blank";
  link.rel = "noreferrer";
  const labelSlot = link.querySelector("[data-slot=provider-link-label]");
  // GitHub gets its mark instead of the word; the name moves to the accessible label and tooltip.
  // The mark already says "another site", so the external-link arrow only shows on hover/focus
  // (see .is-provider-glyph in developer-runtime/styles.css). Other forges keep the text and a
  // permanent arrow, since a lookalike glyph would claim the wrong vendor.
  if (labelSlot && isGitHubUrl(providerUrl)) {
    const glyph = document.createElement("portal-icon");
    glyph.setAttribute("name", "github");
    glyph.setAttribute("size", "md");
    labelSlot.replaceChildren(glyph);
    link.querySelector('portal-icon[name="external-link"]')?.setAttribute("size", "sm");
    link.classList.add("is-provider-glyph");
    link.setAttribute("aria-label", label);
    link.title = label;
  } else if (labelSlot) labelSlot.textContent = label;
  else link.textContent = label;
}

function isGitHubUrl(url) {
  try {
    return /(^|\.)github\.com$/i.test(new URL(url).hostname);
  } catch {
    return false;
  }
}

// A menu is only a useful control when it has at least one visible item. Both Home and Runtime
// use this builder, so a page-specific menu can be composed from links and callbacks without
// leaving behind an empty three-dot trigger.
export function mountActionMenu(host, items, { onToggle, onSelect, ariaLabel = "Actions" } = {}) {
  if (!host) return null;
  host.replaceChildren();
  const usable = (items || []).filter((item) => !item.hidden);
  if (!usable.length) return null;

  const menu = document.createElement("div");
  menu.className = "action-menu";
  const trigger = document.createElement("button");
  trigger.type = "button";
  trigger.className = "menu-trigger";
  trigger.dataset.action = "menu";
  trigger.setAttribute("aria-label", ariaLabel);
  trigger.setAttribute("aria-expanded", "false");
  trigger.append(document.createElement("span"), document.createElement("span"), document.createElement("span"));

  const panel = document.createElement("div");
  panel.className = "menu-panel";
  panel.dataset.menu = "";
  panel.hidden = true;
  for (const item of usable) {
    // A disabled item is always a button (never a link), so there is nothing to follow; it keeps
    // its place in the list to announce what is coming. `hint` adds a small second line.
    const control = item.href && !item.disabled ? document.createElement("a") : document.createElement("button");
    if (control.tagName === "BUTTON") control.type = "button";
    control.textContent = item.label;
    control.dataset.action = item.key;
    if (item.disabled) control.disabled = true;
    if (item.hint) {
      const hint = document.createElement("span");
      hint.className = "menu-item-hint";
      hint.textContent = item.hint;
      control.append(hint);
    }
    if (item.href && control.tagName === "A") {
      control.href = item.href;
      if (item.external) {
        control.target = "_blank";
        control.rel = "noreferrer";
      }
    }
    control.addEventListener("click", (event) => {
      if (!item.href) event.preventDefault();
      event.stopPropagation();
      onSelect?.(item.key, item, event);
    });
    panel.append(control);
  }
  trigger.addEventListener("click", (event) => {
    event.preventDefault();
    event.stopPropagation();
    onToggle?.(host.closest(".instance-card, .repository-card") || host);
  });
  panel.addEventListener("click", (event) => event.stopPropagation());
  menu.append(trigger, panel);
  host.append(menu);
  return menu;
}

export function configureLinksTrigger(button) {
  if (!button) return;
  button.icon = "link";
  button.label = "";
  button.setAttribute("aria-label", "Links");
  button.title = "Links";
}

// Row-level composition boundary shared by Home and Runtime. The host templates provide their own
// page-specific body slots; this function owns the repository identity, provider link, and optional
// action menu that every repository row presents the same way.
export function mountRepositoryRow(node, { name, href, providerUrl, providerLabel, menuItems, onToggleMenu, onSelectMenu, slots = {} }) {
  configureRepositoryName(node, { name, href });
  configureProviderLink(node, providerUrl, providerLabel || "GitHub");
  mountActionMenu(node.querySelector("[data-slot=repository-menu]"), menuItems, {
    onToggle: onToggleMenu,
    onSelect: onSelectMenu,
  });
  slots.header?.(node);
  slots.body?.(node);
  return node;
}

// Checkout/worktree rows have a richer Runtime body than Home, so their unique content stays in
// slots. The shared part still enforces the global identity behavior: the visible branch/worktree
// name is the tooltip trigger and the decorative info icon is never required.
export function mountCheckoutRow(node, { name = null, slots = {} } = {}) {
  const label = node.querySelector("[data-slot=name], [data-slot=root-branch]");
  if (name != null && label) label.textContent = name;
  const trigger = node.querySelector("[data-slot=root-info]") || node.querySelector(".checkout-name-trigger");
  trigger?.querySelector("portal-info-icon")?.remove();
  if (trigger && name) trigger.title = name;
  slots.identity?.(node, trigger);
  slots.actions?.(node);
  slots.body?.(node);
  return node;
}
