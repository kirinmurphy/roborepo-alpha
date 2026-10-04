import crypto from "node:crypto";

// Plan ids are opaque short base36 strings. They are deliberately meaningless: an id that describes
// its plan invites the reader to trust that description, and the description goes stale the moment
// the plan is split, rescoped, or renamed. Filenames and titles are free to track the story; the id
// never moves.
//
// Correctness does not depend on ids being readable. Referential integrity does that job —
// relationshipFindings resolves every depends_on/related/blocked_by against the snapshot, so a
// wrong id of any shape is caught. A format check alone cannot do this: it rejects a malformed id
// but passes a well-formed one that points at nothing.

const ID_LENGTH = 8;
const ALPHABET = "0123456789abcdefghijklmnopqrstuvwxyz";

export const SHORT_ID_PATTERN = /^[0-9a-z]{6,8}$/;

// LEGACY(slug-ids): hyphenated slugs predate the short-id convention. Plans that have one keep it
// permanently — an id is what inbound references resolve against, so rewriting one breaks every
// `related` and `depends_on` pointing at it, and most legacy plans are referenced.
//
// This is deliberately not a migration in progress. Both formats are valid indefinitely; the split
// exists to keep the older one to a single branch and to mark where the convention changed, not to
// stage its removal. Delete this only if every plan is independently reassigned a short id, which
// means rewriting every reference edge in lockstep.
export const LEGACY_SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

// Generates a new opaque id. Collisions are caught by DUPLICATE_PLAN_ID rather than prevented here:
// at 36^8 (~2.8e12) they are vanishingly unlikely across a few hundred plans, and a validator that
// already runs beats a uniqueness check that has to read every plan first.
export function generatePlanId(length = ID_LENGTH) {
  const bytes = crypto.randomBytes(length);
  let id = "";
  for (let index = 0; index < length; index += 1) {
    id += ALPHABET[bytes[index] % ALPHABET.length];
  }
  return id;
}

// The single place that decides whether an id is acceptable, and under which convention. Returns
// "short" (current), "legacy" (accepted, pre-conversion), or "invalid".
//
// Ordering is deliberate: the current format is checked first so it stays the fast, obvious path,
// and the legacy branch reads as the exception it is. Removing legacy support means deleting one
// branch, not untangling a combined pattern.
export function classifyPlanId(id) {
  if (!id) return "invalid";
  if (SHORT_ID_PATTERN.test(id)) return "short";
  // LEGACY(slug-ids): permanent, not staged for removal — see LEGACY_SLUG_PATTERN above.
  if (LEGACY_SLUG_PATTERN.test(id)) return "legacy";
  return "invalid";
}

export function isValidPlanId(id) {
  return classifyPlanId(id) !== "invalid";
}

// Blockers that are not plans. Work is often held up by something with no plan document — an
// upstream project, a vendor, a decision someone else owns — and that belongs in `blocked_by` where
// the portal can see it, not buried in prose. A marked prefix keeps this explicit: anything without
// one is an id and must resolve, so the reference check stays strict.
const EXTERNAL_BLOCKER_PREFIX = /^(upstream|external|vendor|decision):\s*\S/;

export function isExternalBlocker(entry) {
  return typeof entry === "string" && EXTERNAL_BLOCKER_PREFIX.test(entry.trim());
}
