// Retention policy: the shared vocabulary for "what is stale, and how much has to go".
//
// This module holds no I/O. It defines the policy shape, validates it, and turns raw measurements
// into a verdict. log-store.mjs and file-set-store.mjs do the reading; the store itself does the
// writing. That three-way split is the point of the module: before it, developer-runtime and the
// telemetry spool each had their own cutoff arithmetic, their own constants, and their own idea of
// when the work was worth doing — and the two disagreed in ways that were partly deliberate and
// partly accidental, which could only be told apart by reading both in full.
//
// What deliberately does NOT live here is the commit. A whole-file reader needs a temp-file rename;
// a reader holding a byte cursor needs an in-place shrink it can detect. Those are correctness
// requirements of each store's reader, not policy, so each store keeps its own.

export const DAY_MS = 24 * 60 * 60 * 1000;

// A verdict is always one of these two shapes. Callers branch on `act` and nothing else, so a store
// that gains a new policy dimension later does not change how any existing caller reads the result.
export const NO_ACTION = Object.freeze({ act: false, dropCount: 0, reason: "within-policy" });

export function keepVerdict(reason) {
  return { act: false, dropCount: 0, reason };
}

export function dropVerdict(dropCount, reason) {
  return { act: true, dropCount, reason };
}

// A policy with every dimension null is legal and means "unbounded" — used by stores that are
// registered for reporting but deliberately not capped. Validation rejects nonsense values rather
// than silently coercing them, because a typo'd cap that quietly becomes 0 would delete everything.
export function normalizePolicy(policy = {}) {
  const { maxBytes = null, maxAgeDays = null, floorBytes = 0, keepFraction = null } = policy;

  assertPositiveOrNull(maxBytes, "maxBytes");
  assertPositiveOrNull(maxAgeDays, "maxAgeDays");
  assertPositiveOrNull(keepFraction, "keepFraction");
  if (!Number.isFinite(floorBytes) || floorBytes < 0) {
    throw new Error(`retention policy floorBytes must be a non-negative number, got ${floorBytes}`);
  }
  if (keepFraction !== null && keepFraction >= 1) {
    throw new Error(`retention policy keepFraction must be below 1, got ${keepFraction}`);
  }

  return { maxBytes, maxAgeDays, floorBytes, keepFraction };
}

// Age cutoff as an absolute epoch-ms. Returns null when the policy has no age dimension, which
// callers use to skip timestamp parsing entirely rather than comparing against -Infinity.
export function cutoffMillis(policy, now) {
  if (policy.maxAgeDays === null) return null;
  return toMillis(now) - policy.maxAgeDays * DAY_MS;
}

export function toMillis(now) {
  return now instanceof Date ? now.getTime() : new Date(now).getTime();
}

// Shared so the CLI, the portal, and doctor all render a store's size the same way. A store
// reported as "18.8MB" in one surface and "18,874,368 bytes" in another reads as two different
// numbers.
export function formatBytes(bytes) {
  if (bytes >= 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)}MB`;
  if (bytes >= 1024) return `${Math.round(bytes / 1024)}KB`;
  return `${bytes}B`;
}

// Given per-entry byte costs (oldest first) and the total, how many of the oldest must go to fit
// under the cap.
//
// Walks a precomputed length array instead of re-serializing inside the loop — on a large file,
// re-stringifying the retained set on every iteration dominates the cost. Lifted from
// compactHistory, which had this right; capSpool did not and rewrote by line fraction instead.
//
// `keepFraction`, when set, overshoots deliberately: dropping exactly enough to reach the cap means
// the very next append trips it again, so a store that expects steady growth trims further and buys
// itself room. Stores that trim rarely leave it null and drop the minimum.
export function dropCountForBytes(lengths, total, policy) {
  if (policy.maxBytes === null || total <= policy.maxBytes) return 0;

  const target = policy.keepFraction === null
    ? policy.maxBytes
    : Math.floor(policy.maxBytes * policy.keepFraction);

  let remaining = total;
  let dropped = 0;
  // Never drop the final entry: an empty store is indistinguishable from a fresh one, and a single
  // oversized record would otherwise erase itself on every append.
  while (dropped < lengths.length - 1 && remaining > target) {
    remaining -= lengths[dropped];
    dropped += 1;
  }
  return dropped;
}

function assertPositiveOrNull(value, name) {
  if (value === null) return;
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`retention policy ${name} must be a positive number or null, got ${value}`);
  }
}
