// One checkout row on a repository card: the main checkout or a linked worktree. Split out of
// templates.js, which renders every other card kind, so the row's two-column layout and its member
// toggle live in one place. See docs/plans/completed/developer-runtime-repository-row-layout.md.
//
// Imports from templates.js while templates.js imports buildRootSection from here. The cycle is
// safe because neither module calls into the other while it is being evaluated — only from inside
// functions invoked later, at render time.

import { portalMiddleEllipsis } from "/portal/shared/api.js";
import { createRepositoryCheckoutRow } from "/portal/shared/repository-row-template.js";
import { mountCheckoutRow } from "/portal/shared/repository-components.js";
import { healthState, statusDetail, statusText } from "./state.js";
import {
  applyGitDrift,
  applyGitTooltipFields,
  applyResourceConcernBadge,
  composeProjectCard,
  DEFAULT_BRANCHES,
  displayOrigin,
  instanceCard,
  mountMemberMenu,
} from "./templates.js";

// Checkout rows allow longer branch names than the shared git row: the drift warning wraps onto the
// next line as a unit when the branch needs the room, instead of squeezing it. Still
// capped — and middle-truncated, since the tail usually identifies the branch — so a long name never
// pushes the actions column onto a second line. The full name is the tooltip's heading. Standalone
// cards keep the shared cap (BRANCH_NAME_MAX_LENGTH in templates.js).
const CHECKOUT_BRANCH_MAX_LENGTH = 40;

// Health states worth interrupting for, and the badge tone each gets. Healthy and unknown say
// nothing: silence is the healthy state.
const HEALTH_BADGE_TONES = { starting: "warn", degraded: "warn", unhealthy: "danger" };

let memberListSequence = 0;

// `root` is undefined for the main slot when nothing has resolved a rootId yet (no active listener
// on the main checkout) — the row still renders, so the card never looks like it is missing a piece.
// `identity` ({ glyph, label, node }) lets the calling page name the row itself: its glyph and
// accessible label replace the checkout's, and its node replaces the branch label, checkout tooltip,
// and copy control at the start of the identity line. Git drift and the actions column still come
// from `root`, so the row behaves exactly like the checkout it is. Home names a worktree by the plan
// it implements this way; the row stays agnostic about what the node holds.
export function buildRootSection({ root, departed = [], repository, composeActions, instanceActions, mode = "runtime", onMountLinks, identity = null }) {
  const section = createRepositoryCheckoutRow({ controls: mode !== "home" });
  // Lets a rebuild find "this same checkout's" row across renders (see reconcileSection in app.js)
  // to carry its open/closed state forward — rootId is stable across polls, DOM position is not.
  section.dataset.rootId = root?.rootId || "main";

  const glyph = section.querySelector("[data-slot=root-glyph]");
  glyph.setAttribute("name", identity?.glyph || (root?.isWorktree ? "tree" : "home"));
  glyph.setAttribute("role", "img");
  glyph.setAttribute("aria-label", identity?.label || (root?.isWorktree ? "Linked worktree" : "Main checkout"));

  const composeGroups = root?.composeGroups || [];
  if (identity) section.querySelector(".repository-root-identity-line").prepend(identity.node);
  else fillIdentity(section, root, composeGroups);
  mountCheckoutRow(section);
  if (root?.git) {
    applyGitDrift(section, root.git);
    if (!identity) mountCopyDropdown(section, root);
  }
  fillPromotedLink(section, root);
  if (mode === "home") {
    if (root?.primaryEntrypoint?.opaqueKey) onMountLinks?.(section.querySelector("[data-slot=root-links]"), root.primaryEntrypoint);
    section.querySelector("[data-slot=members]")?.remove();
    return section;
  }
  const promotedKey = mountRowLinks(section, root, repository, { composeActions, instanceActions });
  // The promoted member's Links dropdown now lives in the row; its card dropping its own copy keeps
  // one app from offering the same panel twice, a few pixels apart.
  const promotedMemberActions = { ...instanceActions, onMountRoutesTrigger: null };

  // One member, and it is the app the row already links to: a toggle would open onto a card that
  // repeats the row. The row takes the card's remaining parts instead — its ⋮ menu, its facts in the
  // checkout tooltip, and a health badge when something is wrong.
  const onlyMember = root?.members?.length === 1 && !composeGroups.length && !departed.length ? root.members[0] : null;
  if (onlyMember && promotedKey && onlyMember.opaqueKey === promotedKey) {
    foldMemberIntoRow(section, repository, onlyMember, promotedMemberActions);
    return section;
  }

  const members = section.querySelector("[data-slot=members]");
  for (const group of composeGroups) {
    members.append(composeProjectCard(group, composeActions, {
      isMember: true,
      repositoryName: repository.name,
    }));
  }
  for (const member of root?.members || []) {
    const actions = member.opaqueKey && member.opaqueKey === promotedKey ? promotedMemberActions : instanceActions;
    const card = instanceCard(memberProject(repository, member), member.instance, actions);
    applySecondaryPorts(card, member.secondaryPorts);
    // Infrastructure — a database, a socket — is real and worth listing, but it is not something you
    // open, so it reads quieter than the members above it. Tooling and APIs are opened now and then,
    // so they keep full weight.
    if (member.role === "service") card.classList.add("is-support");
    members.append(card);
  }
  // Members whose process is gone. Shown rather than silently removed, matching how a top-level card
  // behaves when its instance exits.
  for (const member of departed) {
    const card = instanceCard(memberProject(repository, member), member.instance, instanceActions);
    card.classList.add("is-offline");
    members.append(card);
  }
  wireMemberToggle(section, members, memberToggleLabel({
    listeners: (root?.members || []).length,
    stacks: composeGroups.length,
    containers: composeGroups.reduce((total, group) => total + group.containers.length, 0),
    stopped: departed.length,
  }));
  return section;
}

// The member list's open state, for reconcileSection in app.js: a poll rebuilds the row as a fresh
// element, and an operator who opened a checkout's members should not see it snap shut.
export function isCheckoutRowOpen(section) {
  return section.classList.contains("is-open");
}

export function setCheckoutRowOpen(section, open) {
  const toggle = section.querySelector("[data-action=toggle-members]");
  if (!toggle || toggle.hidden) return;
  section.classList.toggle("is-open", open);
  section.querySelector("[data-slot=members]").hidden = !open;
  toggle.setAttribute("aria-expanded", String(open));
  // The accessible name states the action; the visible text names what the list holds.
  // The caret has no visible text, so its name (and hover title) says what it opens.
  const name = `${open ? "Hide" : "Show"} ${toggle.dataset.label}`;
  toggle.setAttribute("aria-label", name);
  toggle.title = name;
}

// Branch/worktree label and the checkout tooltip behind it. The row shows the capped label; the
// tooltip leads with the untruncated identity.
function fillIdentity(section, root, composeGroups) {
  const trigger = section.querySelector("[data-slot=root-info]");
  const tooltip = trigger.querySelector("template").content;
  const directory = root?.projectRoot ? basename(root.projectRoot) : null;
  const git = root?.git?.provider?.ok && (root.git.branch || root.git.shortHead) ? root.git : null;
  // Nothing to identify the checkout by: the row keeps its glyph and actions, and no tooltip.
  if (!git && !directory) return;
  trigger.hidden = false;

  const fullName = git ? fullBranchName(git) : directory;
  const label = section.querySelector("[data-slot=root-branch]");
  label.textContent = portalMiddleEllipsis(git ? branchLabel(git) : directory, CHECKOUT_BRANCH_MAX_LENGTH);

  tooltip.querySelector("[data-slot=root-heading]").textContent = fullName;
  // Without git the heading already IS the directory, so there is no second identity to show; and
  // the heading's branch glyph would then be wrong, so it goes too.
  if (git && directory) {
    tooltip.querySelector("[data-slot=root-subheading-line]").hidden = false;
    tooltip.querySelector("[data-slot=root-subheading]").textContent = directory;
    tooltip.querySelector("[data-slot=root-subheading-icon]").setAttribute("name", root?.isWorktree ? "tree" : "home");
  } else if (!git) {
    tooltip.querySelector(".info-tooltip-heading portal-icon")?.remove();
  }
  // The row no longer says when a checkout's directory is gone or unreadable — it has no text column
  // for idle states — so the tooltip carries it instead of the fact disappearing.
  const state = checkoutStateText(root);
  if (state) {
    tooltip.querySelector("[data-slot=root-state-detail]").hidden = false;
    tooltip.querySelector("[data-slot=root-state-text]").textContent = state;
  }
  // The filesystem path is the one fact that distinguishes two checkouts of the same branch.
  if (root?.projectRoot) {
    tooltip.querySelector("[data-slot=root-path-detail]").hidden = false;
    tooltip.querySelector("[data-slot=root-path-text]").textContent = root.projectRoot;
  }
  const names = [
    ...composeGroups.map((group) => `compose ${group.name}`),
    ...(root?.members || []).map((member) => member.name),
  ];
  tooltip.querySelector("[data-slot=root-members-detail]").textContent = names.join(", ") || "none";
  if (git) applyGitTooltipFields(tooltip, git);
}

// The default branch is named by its role — "main branch" reads as where you are, a bare "main" as
// just another branch name.
function branchLabel(git) {
  if (git.detached) return "detached";
  return DEFAULT_BRANCHES.has(git.branch) ? `${git.branch} branch` : git.branch;
}

function fullBranchName(git) {
  if (git.detached) return git.shortHead ? `detached at ${git.shortHead}` : "detached";
  return git.branch;
}

// The one app link the snapshot chose for this checkout (root.primaryEntrypoint). The portal never
// ranks members itself, so what the row promotes and what the snapshot says always agree.
function fillPromotedLink(section, root) {
  const promoted = root?.primaryEntrypoint;
  if (!promoted?.origin) return;
  const link = section.querySelector("[data-slot=root-entrypoint]");
  link.hidden = false;
  link.textContent = displayOrigin(promoted.origin);
  link.href = promoted.origin;
  link.title = promoted.origin;
}

// The Links dropdown for the promoted link, beside it in the actions column. A dev server gets the
// full panel; a Compose container gets discovered pages and APIs only, because saved links are keyed
// to an app record containers do not have. Returns the opaque key of the listener member whose card
// should omit its own copy, or null when there is none.
function mountRowLinks(section, root, repository, { composeActions, instanceActions }) {
  const promoted = root?.primaryEntrypoint;
  if (!promoted?.opaqueKey) return null;
  const slot = section.querySelector("[data-slot=root-links]");
  if (promoted.kind === "listener") {
    const member = (root.members || []).find((candidate) => candidate.opaqueKey === promoted.opaqueKey);
    if (!member || !instanceActions?.onMountRoutesTrigger) return null;
    slot.hidden = false;
    instanceActions.onMountRoutesTrigger(slot, memberProject(repository, member), member.instance);
    return promoted.opaqueKey;
  }
  for (const group of root.composeGroups || []) {
    const instance = group.containers
      .flatMap((container) => container.instances)
      .find((candidate) => candidate.opaqueKey === promoted.opaqueKey);
    if (!instance || !composeActions?.onMountRoutesTrigger) continue;
    slot.hidden = false;
    composeActions.onMountRoutesTrigger(slot, { identity: group.identity, name: group.name }, instance, { discoveredOnly: true });
    return null;
  }
  return null;
}

// An empty list gets no toggle at all: a disclosure that opens onto nothing advertises content it
// does not have.
function wireMemberToggle(section, members, label) {
  if (!members.children.length) return;
  const toggle = section.querySelector("[data-action=toggle-members]");
  toggle.hidden = false;
  toggle.dataset.label = label;
  memberListSequence += 1;
  members.id = `checkout-members-${memberListSequence}`;
  toggle.setAttribute("aria-controls", members.id);
  toggle.addEventListener("click", () => setCheckoutRowOpen(section, !isCheckoutRowOpen(section)));
  setCheckoutRowOpen(section, false);
}

// What the toggle opens, in words, for its accessible name and hover title — the caret itself shows
// no text. A
// Compose stack is one member but holds several containers, so a Compose-only checkout counts those
// instead — "container" already says Docker, so the label does not add "Compose". Stopped members
// are named as such rather than folded into the running count.
function memberToggleLabel({ listeners, stacks, containers, stopped }) {
  const parts = [];
  if (stacks && !listeners) {
    parts.push(plural(containers, "container"));
  } else if (listeners + stacks) {
    parts.push(plural(listeners + stacks, "member"));
  }
  if (stopped) parts.push(`${stopped} stopped`);
  return parts.join(" · ");
}

function plural(count, noun) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The single-member row. The member's card is still built — it is the one place that assembles a
// member's tooltip facts — but never shown: its tooltip lines move into the checkout tooltip under
// an "App" group, and its menu is mounted into the row by the same wiring the card uses.
function foldMemberIntoRow(section, repository, member, actions) {
  const project = memberProject(repository, member);
  const card = instanceCard(project, member.instance, actions);
  const trigger = section.querySelector("[data-slot=root-info]");
  trigger.hidden = false;
  const tooltip = trigger.querySelector("template").content;
  const anchor = tooltip.querySelector("[data-slot=root-checkout-group]");
  const group = document.createElement("span");
  group.className = "info-tooltip-group";
  group.textContent = "App";
  anchor.before(group);
  const facts = card.querySelector(".info-wrap > template").content.querySelector(".info-tooltip-content");
  // Hidden lines are the card's git fields, which members never fill: git is the checkout's, and
  // already sits in its own group below.
  for (const line of [...facts.children]) {
    if (!line.hidden) anchor.before(line);
  }
  if (member.secondaryPorts?.length) {
    const line = document.createElement("span");
    const label = document.createElement("strong");
    label.textContent = "Also on";
    const value = document.createElement("span");
    value.textContent = `:${member.secondaryPorts.join(" :")}`;
    line.append(label, value);
    anchor.before(line);
  }

  const state = healthState(member.instance);
  const badge = section.querySelector("[data-slot=root-health]");
  if (HEALTH_BADGE_TONES[state]) {
    badge.hidden = false;
    badge.textContent = state;
    badge.dataset.tone = HEALTH_BADGE_TONES[state];
    badge.title = `${statusText(member.instance)} · ${statusDetail(member.instance)}`;
  }
  applyResourceConcernBadge(section, member.cpuPercentOfHost);

  const menuHost = section.querySelector("[data-slot=root-menu]");
  menuHost.hidden = false;
  mountMemberMenu(menuHost, project, member.instance, actions);
}

// The copy control on a checkout row, sized to what is actually worth copying there.
//
// Two identifiers are candidates — the branch name and the checkout's filesystem path — but neither
// is universal:
//   - Branch: skipped on a default branch. Nobody pastes "main" into a checkout.
//   - Path: skipped on the main checkout. Its path is the repository's own directory, which is not
//     the thing you are reaching for — the worktree paths are.
//
// What survives decides the control's SHAPE: two items get a dropdown, one gets a plain copy button
// (a caret guarding a single choice is a click that asks a question with one answer), and zero gets
// no control at all.
function mountCopyDropdown(section, root) {
  const slot = section.querySelector("[data-slot=root-copy]");
  const git = root.git;
  const items = [];
  // Detached HEAD has no branch name to skip — the short SHA is exactly what you would copy.
  if (git?.detached) {
    items.push({ label: "Copy commit SHA", value: () => git.shortHead || "" });
  } else if (git?.branch && !DEFAULT_BRANCHES.has(git.branch)) {
    items.push({ label: "Copy branch name", value: () => git.branch || "" });
  }
  // Worktree checkouts only, and only when the path actually resolved — an item that copies nothing
  // is worse than an absent one, since it reports success while writing an empty clipboard.
  if (root.isWorktree && root.projectRoot) {
    items.push({ label: "Copy worktree path", value: root.projectRoot });
  }

  if (!items.length) return;
  if (items.length === 1) {
    const button = document.createElement("portal-copy-button");
    button.setAttribute("icon", "copy");
    // The same glyph size as the copy dropdown's trigger (tpl-copy-menu-trigger), so rows with one
    // copy action and rows with two show the same icon.
    button.setAttribute("icon-size", "md");
    button.setAttribute("aria-label", items[0].label);
    button.copySource = items[0].value;
    slot.append(button);
    return;
  }
  const menu = document.createElement("portal-copy-menu");
  menu.items = items;
  slot.append(menu);
}

// A checkout that is not on disk says THAT, rather than nothing: "absent" is a fact about the
// directory, "unreadable" an admission that we could not look.
export function checkoutStateText(root) {
  if (root?.checkoutState === "absent") return "checkout missing";
  if (root?.checkoutState === "unreadable") return root.checkoutReason || "checkout unreadable";
  return null;
}

// Other ports the same process holds. Plain text, not links: these are facts about the process (an
// HMR socket, an internal API) rather than things to open.
function applySecondaryPorts(card, secondaryPorts) {
  if (!secondaryPorts?.length) return;
  const slot = card.querySelector("[data-slot=secondary-ports]");
  if (!slot) return;
  slot.hidden = false;
  slot.textContent = `also :${secondaryPorts.join(" :")}`;
  slot.title = `Same process also listening on ${secondaryPorts.join(", ")}`;
}

// Members arrive flattened for rendering, but instanceCard expects the project-shaped object the
// legacy collections handed it. Rebuild just the fields it reads.
//
// Git is always suppressed: each member renders inside its own checkout row, which already shows
// that checkout's git once.
function memberProject(repository, member) {
  return {
    name: repository.name,
    identity: member.projectIdentity,
    suppressGit: true,
    // Marks this card as nested, so it names itself rather than repeating the repository heading
    // and renders at member weight rather than card-heading weight.
    isMember: true,
  };
}

function basename(filePath) {
  return filePath.replace(/[\\/]+$/, "").split(/[\\/]/).pop() || filePath;
}
