// Host bind-mount sources per container, used to recover a Compose project's repository when the
// project carries no `com.docker.compose.project.working_dir` label.
//
// Containers started by a tool other than `docker compose up` — Supabase CLI is the case that
// motivated this — get `com.docker.compose.project` but no working_dir, so discovery.mjs's
// auto-derivation has nothing to resolve from. Their bind mounts still point into the project
// directory, which discovery.mjs can use to resolve a repository.
//
// Deliberately a separate call from docker.mjs's `docker ps`: mounts are not in `docker ps` output
// at any --format, so this needs `docker inspect`. One batched call for every container id that
// needs inspecting, not one per container, matching the same "N things, one call" discipline as the
// rest of this module. Discovery reuses the results for repository resolution and checkout
// ownership classification.

import { defaultRunCommand } from "./command-exec.mjs";

// Crosses the same Docker Desktop VM-proxy boundary as `docker ps`/`docker stats` (see docker.mjs
// for why that needs more headroom than lsof/ps), and inspects several containers per call.
export const DOCKER_MOUNTS_TIMEOUT_MS = 6000;

export async function collectDockerMounts(containerIds, {
  platform = process.platform,
  runCommand = defaultRunCommand,
  timeoutMs = DOCKER_MOUNTS_TIMEOUT_MS,
} = {}) {
  const ids = [...new Set(containerIds)].filter((id) => typeof id === "string" && id);
  if (platform !== "darwin" || ids.length === 0) return new Map();

  let result;
  try {
    result = await runCommand("docker", ["inspect", "--format", "{{json .}}", ...ids], { timeoutMs });
  } catch {
    // A container that exited between `docker ps` and here makes `docker inspect` exit non-zero.
    // Missing mount data costs a repo association, never the scan — absence, not an error.
    return new Map();
  }
  return parseDockerInspectOutput(result.stdout ?? result);
}

// One independently-parseable JSON object per line, same shape as `docker ps --format '{{json .}}'`,
// so a single malformed line is skipped rather than invalidating the batch.
//
// Keyed by the SHORT id: `docker inspect` reports the full 64-char `Id` while `docker ps` (and
// therefore every container record in this module) carries the 12-char form. Truncating here is
// what lets callers join on the id they already hold.
export function parseDockerInspectOutput(output) {
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
    if (!raw || typeof raw !== "object" || typeof raw.Id !== "string" || !raw.Id) continue;
    byContainerId.set(raw.Id.slice(0, 12), bindSources(raw.Mounts));
  }
  return byContainerId;
}

// Only `bind` mounts carry a host path worth resolving. Named volumes (`volume`) live inside
// Docker's own storage and say nothing about where the project lives on disk.
function bindSources(mounts) {
  if (!Array.isArray(mounts)) return [];
  const sources = [];
  for (const mount of mounts) {
    if (!mount || mount.Type !== "bind") continue;
    if (typeof mount.Source !== "string" || !mount.Source.startsWith("/")) continue;
    const source = hostPathFromMountSource(mount.Source);
    if (!sources.includes(source)) sources.push(source);
  }
  return sources;
}

// Docker Desktop on macOS runs containers in a Linux VM and reports bind sources through its
// gateway prefix — /Users/me/app is reported as /host_mnt/Users/me/app. Every consumer of these
// paths compares them against real host paths (checkout roots, project identity), so the prefix has
// to come off here rather than at each call site, where forgetting it fails silently: a stack whose
// mounts "resolve to no checkout" looks exactly like a legitimately shared one.
//
// Only stripped when a real host path remains underneath. A literal /host_mnt directory is not
// assumed to exist, but neither is the prefix removed to produce an empty path.
//
// Repeated slashes come off for the same reason: a compose file interpolating a variable that
// already ends in "/" (TMPDIR on macOS does) yields sources like /var/folders/T//project/data, which
// no prefix comparison matches and which no UI printing the path makes obvious.
//
// The /private symlink difference is NOT handled here, deliberately — it has to be applied to the
// checkout roots as well as the mounts, so it lives with the comparison in classifyComposeOwnership
// rather than on one side of it.
function hostPathFromMountSource(source) {
  const stripped = source.replace(/^\/host_mnt(?=\/)/, "") || source;
  return stripped.replace(/\/{2,}/g, "/");
}
