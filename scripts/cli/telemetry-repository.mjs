// Read-time canonical repository resolution for telemetry events. An event belongs to the
// repository its own repository_id names; an event without one belongs to no repository. Nothing is
// inferred from labels or hashes, and the spool is never rewritten. Provenance is exposed so UI can
// explain how a record was matched.

// Resolve one event to { repositoryId, provenance }. Provenance is one of:
//   direct      — the record carries a canonical repository_id
//   unresolved  — it does not; the record stays unassociated
export function repositoryRefForEvent(event) {
  const repositoryId = event?.repo?.repository_id || null;
  return repositoryId ? { repositoryId, provenance: "direct" } : { repositoryId: null, provenance: "unresolved" };
}
