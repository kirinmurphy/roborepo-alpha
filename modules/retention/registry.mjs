// The list of every bounded local store: where it lives, what shape it is, and what bounds it.
//
// One registry so that adding a store means one entry here rather than a new hand-rolled cap plus a
// new doctor check plus a new CLI branch. `maintenance stores`, the doctor checks, and the portal
// Monitoring row all read this.
//
// stateRoot is a parameter rather than an import, matching historyPathFor in
// modules/developer-runtime/history.mjs and settingsPathFor in its settings.mjs. That is what makes the
// whole registry testable against a temp directory with no environment juggling.

import path from "node:path";

export const LOG_SHAPE = "log";
export const FILE_SET_SHAPE = "file-set";

const MB = 1024 * 1024;

// Bounds are stated here, not in the stores that write them, so every cap is visible in one place
// and a store cannot quietly disagree with the value doctor reports for it.
//
// A null dimension means that dimension does not apply — not "unlimited by oversight". Every entry
// must have at least one non-null bound; assertBounded enforces it and the test asserts it, which
// is what stops a future store from being registered without one.
export function retentionStores(stateRoot) {
  return [
    {
      id: "developer-runtime-history",
      label: "Runtime history",
      shape: LOG_SHAPE,
      target: path.join(stateRoot, "developer-runtime", "history.jsonl"),
      // Matches DEFAULT_RETENTION_DAYS/HISTORY_MAX_BYTES/HISTORY_COMPACT_FLOOR_BYTES.
      //
      // maxAgeDays here is the DEFAULT. The live value is a user preference
      // (preferences.historyRetentionDays, 1-365, see modules/developer-runtime/settings-schema.mjs), so
      // this entry declares `preferenceKey` and callers pass the resolved value through
      // resolveStorePolicy. Reporting surfaces that have no settings loaded still show a truthful
      // default rather than nothing.
      policy: { maxAgeDays: 14, maxBytes: 2 * MB, floorBytes: 64 * 1024, keepFraction: null },
      preferenceKey: "historyRetentionDays",
      description: "App health, origin, and exposure transitions.",
    },
    {
      id: "telemetry-spool-claude",
      label: "Telemetry spool (claude)",
      shape: LOG_SHAPE,
      target: path.join(stateRoot, "telemetry", "spool", "claude.jsonl"),
      // Unchanged from SPOOL_MAX_BYTES/SPOOL_KEEP_FRACTION. No age dimension: the spool is a drain
      // buffer, so an old record is not stale, only undrained.
      policy: { maxAgeDays: null, maxBytes: 25 * MB, floorBytes: 0, keepFraction: 0.7 },
      description: "Per-event session capture awaiting analysis.",
    },
    {
      id: "telemetry-spool-codex",
      label: "Telemetry spool (codex)",
      shape: LOG_SHAPE,
      target: path.join(stateRoot, "telemetry", "spool", "codex.jsonl"),
      policy: { maxAgeDays: null, maxBytes: 25 * MB, floorBytes: 0, keepFraction: 0.7 },
      description: "Per-event session capture awaiting analysis.",
    },
    {
      id: "telemetry-markers",
      label: "Telemetry markers",
      shape: LOG_SHAPE,
      target: path.join(stateRoot, "telemetry", "events", "markers.jsonl"),
      // Untuned runaway guard. Markers are user-authored and measured in hundreds of bytes, so this
      // is orders of magnitude above steady state by design.
      policy: { maxAgeDays: null, maxBytes: 5 * MB, floorBytes: 0, keepFraction: null },
      description: "User-authored change annotations.",
    },
    {
      id: "telemetry-snapshots",
      label: "Telemetry snapshots",
      shape: FILE_SET_SHAPE,
      target: path.join(stateRoot, "telemetry", "snapshots"),
      policy: { maxAgeDays: null, maxBytes: 5 * MB, floorBytes: 0, keepFraction: null },
      description: "Content-addressed configuration snapshots referenced by markers.",
    },
    {
      id: "telemetry-experiments",
      label: "Telemetry experiments",
      shape: FILE_SET_SHAPE,
      target: path.join(stateRoot, "telemetry", "experiments"),
      // Bytes, not age: an experiment is a live mutable record, and expiring one mid-run by mtime
      // would discard the definition its end marker still refers to.
      policy: { maxAgeDays: null, maxBytes: 5 * MB, floorBytes: 0, keepFraction: null },
      description: "Live experiment definitions pairing start and end markers.",
    },
    {
      id: "capture-dense-bash-claude",
      label: "Dense bash capture (claude)",
      shape: LOG_SHAPE,
      target: path.join(stateRoot, "capture", "claude", "dense-bash.jsonl"),
      // Highest-volume writer here: fires on a large share of Bash calls, not only on state change.
      // At ~604 bytes/record, 10MB is roughly 17,000 commands.
      policy: { maxAgeDays: 30, maxBytes: 10 * MB, floorBytes: 64 * 1024, keepFraction: null },
      description: "Shell commands that are hard to read or impossible to allowlist.",
    },
    {
      id: "browser-evidence",
      label: "Browser evidence",
      shape: FILE_SET_SHAPE,
      target: path.join(stateRoot, "browser", "evidence"),
      // Screenshots, videos, and traces from `roborepo browser run`. Evidence only has to outlive
      // the conversation that cites it, so age is the real policy; the byte cap is a backstop for
      // video, which dominates size. Pruned when a run starts, never mid-run, so a run's own
      // artifacts always survive to be cited.
      policy: { maxAgeDays: 14, maxBytes: 250 * MB, floorBytes: 0, keepFraction: null },
      filter: isBrowserEvidenceFile,
      description: "Screenshots, recordings, and traces captured as verification evidence.",
    },
  ];
}

// Evidence files are flat (`<run-id>-<n>-<type>.<ext>`) so the file-set measurement applies as is;
// the filter keeps anything else that lands in the directory out of the count.
export function isBrowserEvidenceFile(name) {
  return /\.(png|webm|zip)$/.test(name);
}

export function findRetentionStore(stateRoot, id) {
  return retentionStores(stateRoot).find((store) => store.id === id) ?? null;
}

// Overlay a live user preference onto a store's declared default.
//
// The registry cannot read the preference itself: developer-runtime owns its settings file, and importing
// it here would point a leaf module at a feature module. So the store declares WHICH preference
// governs it and the caller — which already has the settings loaded — supplies the value.
//
// An out-of-range or missing value falls back to the declared default rather than throwing.
// Retention runs on the append path, and a hand-edited settings file must not be able to stop a
// store from being written to.
export function resolveStorePolicy(store, preferences = null) {
  if (!store.preferenceKey || !preferences) return store.policy;
  const value = preferences[store.preferenceKey];
  if (!Number.isInteger(value) || value < 1 || value > 365) return store.policy;
  return { ...store.policy, maxAgeDays: value };
}

// Every registered store must actually be bounded. Called by the test, and by the registry's own
// consumers, so an entry added with all-null bounds fails loudly instead of silently growing.
export function assertBounded(stores) {
  const unbounded = stores.filter(
    (store) => store.policy.maxAgeDays === null && store.policy.maxBytes === null,
  );
  if (unbounded.length > 0) {
    throw new Error(
      `retention registry: unbounded store(s): ${unbounded.map((store) => store.id).join(", ")}`,
    );
  }
  return stores;
}
