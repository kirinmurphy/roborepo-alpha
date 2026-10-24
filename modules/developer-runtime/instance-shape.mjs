// Shaping a listener + identity + probe into the instance record the snapshot and portal consume.
// Split out of discovery.mjs so that file stays a short orchestration of the scan's steps while the
// record's structure — and the association-key derivation everything downstream depends on — lives
// in one place.

import { createHash } from "node:crypto";
import path from "node:path";
import { classifyHealth } from "./health.mjs";

export function toInstance({ listener, identity, candidates, probe, cwd, git = null, health = null, docker = null, processMetrics = null, provenance = null }) {
  const origin = probe?.origin || candidates[0]?.origin || null;
  const matchSignature = buildMatchSignature(identity, listener.command, cwd, probe?.title);
  return {
    key: `${listener.pid}:${listener.address}:${listener.port}`,
    associationKey: matchSignature.key,
    matchSignature,
    origin,
    alternateOrigins: candidates
      .map((candidate) => candidate.origin)
      .filter((candidate) => candidate !== origin),
    bind: {
      address: listener.address,
      port: listener.port,
      scope: listener.bindScope,
      warning: listener.bindScope === "loopback" ? null : "Listener is exposed beyond loopback.",
    },
    status: probe?.status ?? null,
    latencyMs: probe?.latencyMs ?? null,
    protocol: probe?.protocol ?? candidates[0]?.protocol ?? "http",
    // Keep certificate warnings even when a local metadata retry recovered a page and status.
    tls: probe?.tls ?? null,
    title: probe?.title ?? null,
    contentType: probe?.contentType ?? null,
    health,
    // null when the container/metrics provider is unsupported, failed, or found nothing for this
    // instance — never a fabricated empty object, matching the correct-or-absent discipline git
    // already follows for dirty/ahead/behind.
    docker,
    processMetrics,
    process: { pid: listener.pid, command: listener.command },
    // Who launched this listener, derived by walking the process tree to a recognizable ancestor.
    // Null when ancestry could not be resolved (non-darwin, or the walk hit an unknown parent) —
    // absent rather than guessed, matching the discipline the rest of this record follows.
    provenance,
    project: git ? { ...identity, git } : identity,
  };
}

// Health is classified after association keys are final, because the previous health record is
// looked up by associationKey and disambiguateAssociationKeys can still swap in the titleKey.
//
// `context` carries the real probe result and the already-alias-resolved app settings for each
// instance, both of which discovery.mjs holds during its scan. Reconstructing either here would
// silently lose fields — an earlier version rebuilt a probe from the flattened instance and dropped
// `tls`/`errorCode`, which turned a self-signed cert into `unhealthy` instead of `degraded`.
export function attachHealth(instances, { previousHealth = new Map(), context = null, now = new Date() } = {}) {
  for (const instance of instances) {
    const entry = context?.get(instance) || null;
    instance.health = classifyHealth({
      probe: entry?.probe ?? null,
      config: entry?.appSettings?.health ?? null,
      previous: previousHealth.get(instance.associationKey) || null,
      now,
    });
  }
  return instances;
}

// Two instances of the same app under one project would collide on the port-free key, so the
// title-qualified variant is promoted for every member of a colliding group.
export function disambiguateAssociationKeys(instances) {
  const counts = new Map();
  for (const instance of instances) {
    const key = instance.matchSignature.key;
    counts.set(key, (counts.get(key) || 0) + 1);
  }
  for (const instance of instances) {
    if (counts.get(instance.matchSignature.key) <= 1) continue;
    instance.associationKey = instance.matchSignature.titleKey;
  }
  return instances;
}

// Deliberately excludes port, PID, and title: an app that restarts on a different port must keep the
// same key so its settings, health history, and event log follow it.
export function buildMatchSignature(identity, command, cwd, title) {
  const relativeCwd = identity.projectRoot && cwd
    ? path.relative(identity.projectRoot, cwd) || "."
    : null;
  const parts = {
    projectIdentity: identity.identity,
    relativeCwd,
    command: safeCommand(command),
  };
  const key = "a" + createHash("sha256").update(JSON.stringify(parts)).digest("hex").slice(0, 24);
  const safeTitle = title ? String(title).slice(0, 120) : null;
  const titleKey = "a" + createHash("sha256")
    .update(JSON.stringify({ ...parts, title: safeTitle }))
    .digest("hex")
    .slice(0, 24);
  return { key, titleKey, ...parts, title: safeTitle };
}

function safeCommand(value) {
  return String(value || "unknown").replace(/[^\w.-]/g, "_").slice(0, 80);
}
