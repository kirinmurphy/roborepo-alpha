// Per-container CPU/memory, read straight from Docker instead of the host `ps` table.
//
// On macOS every Docker-proxied listener is host-side owned by the single shared
// com.docker.backend VM-proxy process, so process-metrics.mjs's PID-keyed `ps` lookup reports the
// same CPU/RSS/uptime for every container across every Compose project — confirmed live, two
// unrelated containers showed the identical PID. `docker stats` asks the VM directly, scoped per
// container, so it is the only route to a real per-container reading.
//
// One `docker stats --no-stream --format {{json .}}` call for every running container in a scan,
// not one call per container — same "N things, one call" discipline as docker.mjs's `docker ps`.

import os from "node:os";
import { defaultRunCommand } from "./command-exec.mjs";

const MEM_UNIT_TO_KB = { B: 1 / 1024, KiB: 1, MiB: 1024, GiB: 1024 * 1024, TiB: 1024 * 1024 * 1024 };

// Budget for the optional per-container metrics pass; independent of Docker discovery's timeout.
export const DOCKER_STATS_TIMEOUT_MS = 6000;

export async function collectDockerStats({
  platform = process.platform,
  runCommand = defaultRunCommand,
  timeoutMs = DOCKER_STATS_TIMEOUT_MS,
  cpuCount = os.cpus().length,
} = {}) {
  if (platform !== "darwin") return new Map();

  let result;
  try {
    result = await runCommand("docker", ["stats", "--no-stream", "--format", "{{json .}}"], { timeoutMs });
  } catch {
    // No running containers, Docker Desktop not up, etc. — absence, not an error the caller sees;
    // discoverDockerRecords already surfaces a warning for the daemon-down/not-installed case, so
    // this call staying silent avoids a duplicate warning for the same root cause.
    return new Map();
  }
  return parseDockerStatsOutput(result.stdout ?? result, { cpuCount });
}

// Each line is an independently-parseable JSON object, matching `docker ps --format`'s shape — one
// malformed line is skipped rather than invalidating the whole scan.
export function parseDockerStatsOutput(output, { cpuCount = os.cpus().length } = {}) {
  const byContainerId = new Map();
  for (const line of String(output || "").split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let raw;
    try {
      raw = JSON.parse(trimmed);
    } catch {
      continue;
    }
    const stats = parseDockerStatsEntry(raw, cpuCount);
    if (stats) byContainerId.set(stats.containerId, stats);
  }
  return byContainerId;
}

// `docker stats` reports CPU as a percentage of ONE core, so a container saturating two cores on an
// 8-core host reads "200%". Percent-of-machine is carried alongside it rather than replacing it:
// the per-core figure is what `docker stats` and every Docker doc show, but it is not summable —
// adding per-core percentages across a project's containers produces a number that means nothing.
// cpuPercentOfHost is the summable one.
function parseDockerStatsEntry(raw, cpuCount) {
  if (!raw || typeof raw !== "object" || !raw.ID) return null;
  const cpuPercent = parsePercent(raw.CPUPerc);
  return {
    containerId: raw.ID,
    cpuPercent,
    cpuPercentOfHost: cpuPercent != null && cpuCount > 0 ? cpuPercent / cpuCount : null,
    residentMemoryKb: parseMemUsage(raw.MemUsage),
  };
}

function parsePercent(value) {
  const match = String(value || "").match(/^([\d.]+)%$/);
  return match ? Number(match[1]) : null;
}

// "151.7MiB / 256MiB" — used vs. limit; only the used side matches what process-metrics.mjs's
// residentMemoryKb already means (current resident usage, not a ceiling).
function parseMemUsage(value) {
  const used = String(value || "").split("/")[0]?.trim();
  const match = used?.match(/^([\d.]+)(B|KiB|MiB|GiB|TiB)$/);
  if (!match) return null;
  const multiplier = MEM_UNIT_TO_KB[match[2]];
  return multiplier ? Number(match[1]) * multiplier : null;
}
