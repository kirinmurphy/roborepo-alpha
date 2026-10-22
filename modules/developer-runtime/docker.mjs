// Docker/Compose enrichment: read-only inspection of running containers, merged onto discovered
// listeners by published host port. Mirrors the lsof.mjs/listeners.mjs split — a subprocess-calling
// orchestrator here, pure parsers exported separately so they're unit-testable without a real
// `docker` binary.
//
// One `docker ps` call per scan, not one per container: same "N things, one call" discipline as
// git's per-root dedup. `docker ps --format '{{json .}}'` already carries Ports and Labels as
// strings, so no per-container `docker inspect` round trip is needed.

import { defaultRunCommand } from "./command-exec.mjs";

export { defaultRunCommand };

// Docker CLI calls cross into Docker Desktop's VM proxy rather than talking to a local daemon
// directly, so they run measurably slower than lsof/ps and need more headroom than the 1500ms used
// for those. Verified against a live `docker ps` on a machine with a running Compose stack, where a
// 1500ms budget intermittently killed the call mid-flight (code 143/SIGTERM).
//
// Raised again from 6000ms for the same reason one tier up: on a machine running ~11 containers,
// a cold or contended `docker ps` was measured at 2.1-4.0s while a warm one returns in ~0.7s. A 6s
// ceiling over a 4s worst case left almost no margin, so the scan failed intermittently — visible
// as a "docker discovery failed" warning that came and went with no change on the user's part.
// The cost of a generous ceiling is bounded (one call per scan, and it only waits when Docker is
// genuinely slow); the cost of a tight one is a dashboard that randomly drops every container.
export const DOCKER_DISCOVERY_TIMEOUT_MS = 15000;

export async function discoverDockerRecords({
  platform = process.platform,
  runCommand = defaultRunCommand,
  timeoutMs = DOCKER_DISCOVERY_TIMEOUT_MS,
} = {}) {
  if (platform !== "darwin") return { warnings: [], containers: [] };

  let result;
  try {
    result = await runCommand("docker", ["ps", "--format", "{{json .}}"], { timeoutMs });
  } catch (err) {
    return { warnings: [dockerFailureWarning(err, timeoutMs)], containers: [] };
  }
  return { warnings: [], containers: parseDockerPsOutput(result.stdout ?? result) };
}

// Each line is an independently-parseable JSON object (`docker ps --format '{{json .}}'`, not a
// single JSON array), so one malformed line is skipped rather than invalidating the whole scan.
export function parseDockerPsOutput(output) {
  const containers = [];
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const container = parseDockerPsEntry(raw);
    if (container) containers.push(container);
  }
  return containers;
}

function parseDockerPsEntry(raw) {
  if (!raw || typeof raw !== "object" || !raw.ID) return null;
  const labels = parseLabels(raw.Labels);
  return {
    containerId: raw.ID,
    name: raw.Names || null,
    image: raw.Image || null,
    state: raw.State || null,
    composeProject: labels["com.docker.compose.project"] || null,
    composeService: labels["com.docker.compose.service"] || null,
    workingDir: labels["com.docker.compose.project.working_dir"] || null,
    publishedPorts: parsePublishedPorts(raw.Ports),
  };
}

// `Labels` is a comma-joined `key=value,key=value` string. Compose label values never contain
// commas in practice (they are project/service slugs), so a plain split is sufficient here.
function parseLabels(value) {
  const labels = {};
  for (const pair of String(value || "").split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    labels[pair.slice(0, eq).trim()] = pair.slice(eq + 1).trim();
  }
  return labels;
}

// `Ports` looks like "0.0.0.0:5432->5432/tcp, :::5432->5432/tcp" — zero, one, or many
// comma-separated bindings, and a container with no published ports has an empty string.
function parsePublishedPorts(value) {
  const ports = [];
  const seen = new Set();
  for (const binding of String(value || "").split(",")) {
    const match = binding.trim().match(/:(\d+)->(\d+)\/(tcp|udp)/);
    if (!match) continue;
    const hostPort = Number(match[1]);
    const containerPort = Number(match[2]);
    if (!Number.isInteger(hostPort) || !Number.isInteger(containerPort)) continue;
    const key = `${hostPort}:${containerPort}:${match[3]}`;
    if (seen.has(key)) continue;
    seen.add(key);
    ports.push({ hostPort, containerPort, protocol: match[3] });
  }
  return ports;
}

// Distinguishes "Docker Desktop not running" / "docker not installed" from a genuine permission
// failure, so the warning is actionable rather than a raw ENOENT/errno dump.
function dockerFailureWarning(err, timeoutMs = DOCKER_DISCOVERY_TIMEOUT_MS) {
  if (err.code === "ENOENT") return "docker discovery skipped: docker CLI not found";
  const message = String(err.message || "");
  // A timeout kills the child with SIGTERM, so execFile reports the generic "Command failed" with
  // no reason attached — which is exactly the uninformative warning that made this hard to
  // diagnose from the UI. Named explicitly, and pointed at the cause the user can act on.
  if (err.killed || err.signal === "SIGTERM" || err.code === "ETIMEDOUT") {
    return `docker discovery timed out after ${timeoutMs}ms — Docker may be slow to respond or starting up`;
  }
  if (/permission denied/i.test(message)) return `docker discovery failed: permission denied (${message})`;
  if (/cannot connect to the docker daemon|dial unix|no such file or directory/i.test(message)) {
    return "docker discovery skipped: docker daemon is not running";
  }
  return `docker discovery failed: ${message}`;
}
