// Repository lifecycle: what state a persisted repository is in right now.
//
// Derived on every scan rather than stored. Two of the three states depend on whether a directory
// is readable *at this moment* — an unplugged drive changes the answer without the record changing
// at all — so persisting them would let the registry assert something that was true when it was
// written and false when it is read. The registry keeps the durable facts (firstSeenAt/lastSeenAt,
// which roots exist); this derives the observation.
//
// The distinction the whole module turns on is between LOOKING AND FINDING NOTHING and NOT BEING
// ABLE TO LOOK. Only the first is evidence a checkout is gone. Treating an unreadable parent as
// absence would mark every repository on an unmounted share as `stale` the moment it is unplugged.

import fs from "node:fs";
import path from "node:path";
import { checkoutRootsFor } from "./registry.mjs";

export const LIFECYCLE_STATES = ["active", "idle", "stale"];

// 30 days. Measured from lastSeenAt — see ageOutCandidates below for why not from staleness.
export const AGE_OUT_MS = 30 * 24 * 60 * 60 * 1000;

// A single checkout's readability, as three outcomes rather than a boolean, because "I could not
// look" must never collapse into "it is not there".
//   present     - the directory and its .git both resolve
//   absent      - the parent is readable and the checkout genuinely is not in it
//   unreadable  - the parent could not be read at all (unmounted share, unplugged drive, EACCES)
export function inspectCheckout(rootPath, { fsApi = fs } = {}) {
  try {
    fsApi.statSync(rootPath);
  } catch (err) {
    if (err?.code === "ENOENT") {
      // The checkout is not here. Whether that is evidence depends entirely on whether we could
      // read the directory that would contain it.
      const parent = path.dirname(rootPath);
      try {
        fsApi.statSync(parent);
        return { state: "absent", reason: "checkout directory no longer exists" };
      } catch {
        return { state: "unreadable", reason: "parent directory is not readable" };
      }
    }
    // EACCES/EPERM/EIO and friends: we were blocked, not answered.
    return { state: "unreadable", reason: `checkout is not readable (${err?.code || "unknown"})` };
  }
  // The directory exists. A checkout without a .git entry is no longer a repository — that IS a
  // finding, not a failure to look. .git is a directory in a clone and a file in a worktree, so its
  // presence is what matters, not its type.
  try {
    fsApi.statSync(path.join(rootPath, ".git"));
  } catch (err) {
    if (err?.code === "ENOENT") return { state: "absent", reason: "no longer a git checkout" };
    return { state: "unreadable", reason: `.git is not readable (${err?.code || "unknown"})` };
  }
  return { state: "present", reason: null };
}

// The lifecycle state of one repository.
//
// `runningRepositoryIds` is the set resolved by the current scan — a repository with a live
// listener is `active` and nothing on disk needs consulting, which also keeps the common case free
// of filesystem calls.
//
// A repository is `stale` only when EVERY checkout was looked at and none survived. One readable
// checkout keeps it `idle`, and — critically — one *unreadable* checkout also keeps it `idle`,
// because an unreadable checkout is not evidence of anything.
export function deriveLifecycle(registry, repositoryId, { runningRepositoryIds = new Set(), fsApi = fs } = {}) {
  if (runningRepositoryIds.has(repositoryId)) {
    return { state: "active", reason: null, checkouts: [] };
  }
  const roots = checkoutRootsFor(registry, repositoryId);
  if (!roots.length) {
    // Known repository, no path ever recorded (registered by a source that never resolved a root).
    // Nothing was looked at, so this cannot be stale.
    return { state: "idle", reason: "no checkout path on record", checkouts: [] };
  }
  const checkouts = roots.map((root) => ({ ...root, ...inspectCheckout(root.path, { fsApi }) }));
  if (checkouts.some((c) => c.state === "present")) {
    return { state: "idle", reason: null, checkouts };
  }
  if (checkouts.some((c) => c.state === "unreadable")) {
    // Could not look. Never treat as absence, however many other checkouts are confirmed gone.
    const blocked = checkouts.find((c) => c.state === "unreadable");
    return { state: "idle", reason: blocked.reason, checkouts };
  }
  return { state: "stale", reason: checkouts[0].reason, checkouts };
}

// The repository that now owns every checkout this one used to, or null.
//
// This is the read side of a deliberate rename decision: when a checkout resolves
// to a new git identity the checkout REPOINTS and both records survive, because a renamed remote and
// a deleted-then-recloned directory produce identical stored data and a wrong merge hides one
// repository's work inside another. Nothing is merged automatically, and that still holds.
//
// What changed is that the superseded record became visible. While only running repositories were
// listed it never appeared; once persisted repositories render, a record whose every root has been
// repointed shows up as a full idle card beside the record that took its roots — two "roborepo"
// cards, one of which is a former remote nobody is using. deriveLifecycle cannot tell them apart on
// its own, because a fully-repointed record and a never-resolved one both have zero resolvable
// roots and both read as `idle`.
//
// So this reports the successor rather than acting on it — same discipline as priorRepositoryForRoot
// in the other direction. The caller decides whether to fold the card away, and the record itself is
// untouched and recoverable.
//
// Deliberately conservative. Null unless the record HAS roots (a record that never resolved one is
// not superseded, just unresolved), EVERY one of them is now owned by another repository, and they
// all agree on which. A record whose roots scattered across several successors is left alone: that
// is not a rename, and guessing which one wins is the merge this design refuses to make.
export function supersededBy(registry, repositoryId) {
  const record = registry?.repositories?.[repositoryId];
  const roots = record?.localRoots || [];
  if (!roots.length) return null;
  let successor = null;
  for (const root of roots) {
    const entry = registry.localRootPaths?.[root.rootId];
    // A root with no recorded path says nothing about ownership — it was never located, so it cannot
    // have been taken over. One of these is enough to stop the whole derivation.
    if (!entry) return null;
    if (entry.repositoryId === repositoryId) return null;
    // The successor must still exist; a pointer to a deleted record is not a successor.
    if (!registry.repositories?.[entry.repositoryId]) return null;
    if (successor && successor !== entry.repositoryId) return null;
    successor = entry.repositoryId;
  }
  return successor;
}

// The repository that absorbed this one after a remote rename, or null.
//
// `supersededBy` above answers the same question from `localRootPaths`, the ownership index — which
// is empty for any root registered before that index existed. This reads the `localRoots` arrays
// instead, which every record has always had, and so covers exactly the old records the index
// cannot see. `harness_configs`/`roborepo` on the live registry was one: three roots, none in the
// index, while the shared rootId sat in plain view in both arrays.
//
// A rootId is a hash of an absolute path, so two records listing the same one is direct evidence the
// same DIRECTORY was seen under both remotes. That is the evidence the rename path lacked when it
// refused to merge a rename automatically. Its worry was that "a deleted-then-recloned
// directory produces identical stored data" — but the two are distinguishable here:
//
//   rename : the old record's roots are all still present on the new one. Nothing was left behind,
//            because the directories did not change — only the remote did.
//   reclone: the old record keeps roots the new one never saw (its own worktrees, a former path).
//            A strict subset never holds, so this returns null and the two records stay separate.
//
// Which of the old record's roots have to carry over took two wrong tries, so the reasoning is
// worth stating. Demanding ALL of them fails: a long-lived record accumulates directories abandoned
// well before the rename (the live example had one last touched five days prior), and they say
// nothing about the handover. Filtering by "last seen after the successor was created" fails for a
// deeper reason — the old record STOPS being updated the moment the remote changes, so every one of
// its timestamps predates the successor by construction and the filter admits nothing, ever.
//
// What does discriminate is the MOST RECENTLY SEEN root. That is the directory in use when the
// remote changed, and it is the one the rename necessarily carried across:
//
//   rename : the newest root is on both records. The directory kept working; only its remote moved.
//   reclone: the newest root belongs to the old record alone — the new clone lives somewhere else,
//            or the old directory was replaced and never re-registered under the new id.
//
// Older roots are ignored deliberately. They are history, and requiring them to match punishes a
// record for having been used longer.
//
// The action this justifies is an ALIAS, never a merge. An alias leaves both records intact, renders
// one row, and is undone by deleting one line; the worst case is a row briefly missing rather than
// one repository's work hidden inside another. That asymmetry is what makes acting automatically
// defensible here when merging still would not be.
export function renamedInto(registry, repositoryId) {
  const record = registry?.repositories?.[repositoryId];
  const roots = (record?.localRoots || []).filter((r) => r?.rootId);
  if (!roots.length) return null;
  // The directory in use when this record stopped being written to. Ties and missing timestamps fall
  // back to the last entry, which is the order roots were appended in.
  const newestRoot = roots.reduce((newest, r) => {
    const a = Date.parse(r.lastSeenAt ?? "");
    const b = Date.parse(newest.lastSeenAt ?? "");
    if (!Number.isFinite(a)) return newest;
    if (!Number.isFinite(b)) return r;
    return a >= b ? r : newest;
  });
  const mine = new Set(roots.map((r) => r.rootId));
  let match = null;
  for (const [otherId, other] of Object.entries(registry.repositories || {})) {
    if (otherId === repositoryId) continue;
    // An already-aliased record is not a target; following it would build a chain toward a record
    // that is itself pointing elsewhere.
    if (registry.aliases?.[otherId]) continue;
    const theirs = new Set((other?.localRoots || []).map((r) => r.rootId).filter(Boolean));
    if (!theirs.size) continue;
    // The directory this record was last working in has to be one the successor also knows.
    if (!theirs.has(newestRoot.rootId)) continue;
    // And the successor has to have gone on to see directories this record never did — otherwise
    // there is nothing marking which of the two is the later identity.
    if (theirs.size <= mine.size) continue;
    // Two candidates means the evidence does not name a single successor. Refuse rather than choose.
    if (match) return null;
    match = otherId;
  }
  return match;
}

// The most recent moment anything about this repository was observed. Roots and discoveries both
// carry lastSeenAt; the newest of them is the repository's.
export function lastSeenAtFor(record) {
  const stamps = [
    ...(record?.localRoots || []).map((r) => r.lastSeenAt),
    ...(record?.discoveries || []).map((d) => d.lastSeenAt),
  ].filter(Boolean);
  if (!stamps.length) return null;
  return stamps.reduce((newest, s) => (Date.parse(s) > Date.parse(newest) ? s : newest));
}

// Repositories that should drop out of the normal list because they have not been seen in 30 days.
//
// Two rules that look like edge cases but are the point:
//
// 1. Ageing measures lastSeenAt, NOT time spent stale. A repository on an unplugged drive becomes
//    stale immediately, but it is still one you use; ageing on staleness would hide it within days
//    of unplugging. Ageing on last-seen hides it only if you genuinely stop using it.
//
// 2. A record with no lastSeenAt at all NEVER ages out. "Never seen" is not "seen long ago" — such
//    records exist (registered by a source that never resolved a root), and treating a missing
//    timestamp as infinitely old would hide them all on the first sweep.
//
// This returns candidates rather than hiding them, so the caller owns the write and a repository
// the user explicitly un-hid is not re-hidden behind their back.
export function ageOutCandidates(registry, { now = Date.now(), ageOutMs = AGE_OUT_MS } = {}) {
  const out = [];
  for (const [id, record] of Object.entries(registry.repositories || {})) {
    if (record.visibility === "hidden") continue;
    const lastSeen = lastSeenAtFor(record);
    if (!lastSeen) continue; // Never seen is not seen long ago.
    if (now - Date.parse(lastSeen) > ageOutMs) out.push({ repositoryId: id, lastSeenAt: lastSeen });
  }
  return out;
}
