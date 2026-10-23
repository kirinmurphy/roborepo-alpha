import { capabilityForPlatform } from "./capabilities.mjs";
import { resolveProjectIdentity } from "./identity.mjs";
import { canonicalRepositoryId, rootId as computeRootId } from "../repositories/identity.mjs";
import { createScanCache } from "../repositories/scan-cache.mjs";
import { defaultRunGit } from "../repositories/git-exec.mjs";
import { collectGitContext, collectGitForRoots } from "./git.mjs";
import { attachHealth, disambiguateAssociationKeys, toInstance } from "./instance-shape.mjs";
import { defaultRunCommand } from "./command-exec.mjs";
import { discoverListenerRecords } from "./listeners.mjs";
import { originCandidatesForListener } from "./origin.mjs";
import { probeHttpCandidate } from "./http-probe.mjs";
import { resolveProjectAlias } from "./settings.mjs";
import { discoverDockerRecords } from "./docker.mjs";
import { collectProcessMetrics } from "./process-metrics.mjs";
import { resolveProvenance } from "./provenance.mjs";
import { collectDockerStats } from "./docker-stats.mjs";
import { collectDockerMounts } from "./docker-mounts.mjs";

const PROBE_CONCURRENCY = 8;

export async function discoverInstances(options = {}) {
  const {
    platform = process.platform,
    runCommand = defaultRunCommand,
    probeHttp = probeHttpCandidate,
    probeConcurrency = PROBE_CONCURRENCY,
    resolveIdentity = resolveProjectIdentity,
    collectGit = collectGitContext,
    runGit = defaultRunGit,
    discoverDocker = discoverDockerRecords,
    collectProcess = collectProcessMetrics,
    collectDockerStatsRecords = collectDockerStats,
    collectDockerMountRecords = collectDockerMounts,
    // Deliberately separate from the listener `runCommand`: existing callers/tests configure
    // `runCommand` to answer `lsof`, and must not also have to answer `docker`/`ps` invocations they
    // never asked to opt into. Passing `runCommand` here only takes effect for callers who
    // explicitly provide the corresponding command options.
    runDockerCommand = defaultRunCommand,
    runPsCommand = defaultRunCommand,
    runDockerStatsCommand = defaultRunCommand,
    runDockerMountsCommand = defaultRunCommand,
    previousHealth = new Map(),
    now = new Date(),
    settings = null,
    // repositoryId -> [{ rootId, path }] for every checkout the registry knows, used to place a
    // Compose stack against the checkouts it actually mounts. Injected by the caller (which owns
    // registry access) rather than read here, keeping discovery free of state I/O. Absent means
    // stacks classify as shared/unverified rather than being attributed to a wrong checkout.
    checkoutRootsByRepository = new Map(),
  } = options;
  // One cache per scan, created here and dropped when this call returns. Because
  // refreshDeveloperRuntimeSnapshot invokes discoverInstances exactly once per refresh, "per-scan" and
  // "per-call" are the same boundary. A process-lifetime cache would pin the first branch/dirty
  // reading the portal ever took and report it forever. The option exists only so tests can inspect
  // hit counts.
  const scanCache = options.scanCache || createScanCache();
  const capabilities = capabilityForPlatform(platform);
  const warnings = [];
  if (capabilities.discovery !== "supported") {
    return { capabilities, warnings, instances: [] };
  }

  const listenerProvider = await discoverListenerRecords({ platform, runCommand });
  warnings.push(...listenerProvider.warnings);
  const pending = [];
  const instances = [];

  for (const { listener, cwd } of listenerProvider.records) {
    const identity = withRepositoryFields(cwd
      ? resolveIdentity(cwd, listener.command, options)
      : {
        identity: `process:unknown:${listener.command}`,
        identityKind: "process",
        confidence: "low",
        projectRoot: null,
        evidence: "missing process working directory",
      });
    const appSettings = appSettingsForIdentity(settings, identity.identity);
    const candidates = originCandidatesForListener(listener, appSettings?.originPreference);
    // appSettings is retained (not just its originPreference) so health classification reuses this
    // alias-resolved lookup rather than re-deriving it with a different rule.
    pending.push({ listener, identity, candidates, cwd, appSettings });
  }

  // Git, Docker, and process-metrics collection are each a separate pass rather than work threaded
  // into the probe worker: all three are independent of the probe and of each other. Git dedupes by
  // repository root, Docker is one `docker ps` for the whole scan, and process metrics is one batched
  // `ps` for every discovered PID — so running them concurrently keeps the scan at the cost of the
  // slowest single pass rather than the sum of all four.
  const [probes, gitByRoot, dockerResult, processByPid, dockerStatsByContainerId] = await Promise.all([
    probeHttp
      ? probeCandidatesForInstances(pending, probeHttp, warnings, probeConcurrency)
      : Promise.resolve(new Map()),
    collectGit
      ? collectGitForRoots(pending, { collectGit, scanCache, runGit })
      : Promise.resolve(new Map()),
    discoverDocker ? discoverDocker({ platform, runCommand: runDockerCommand }) : Promise.resolve({ warnings: [], containers: [] }),
    collectProcess ? collectProcess(pending.map((item) => item.listener.pid), { platform, runCommand: runPsCommand }) : Promise.resolve(new Map()),
    collectDockerStatsRecords ? collectDockerStatsRecords({ platform, runCommand: runDockerStatsCommand }) : Promise.resolve(new Map()),
  ]);
  warnings.push(...dockerResult.warnings);
  const dockerByHostPort = indexDockerContainersByHostPort(dockerResult.containers);
  // Every PID that owns a discovered listener, so provenance can stop at the nearest one instead of
  // walking past it — a runtime spawned by another listener here is that listener's child.
  const listenerPids = new Set(pending.map((item) => item.listener.pid));

  // A manually-associated repo (settings.composeProjects[name].repoPath — see settings-schema.mjs
  // for why this is a path rather than an identity) has to be resolved here, not in
  // buildDeveloperRuntimeSnapshot, because git collection is async and which compose projects exist is
  // only known once dockerResult above has resolved. One extra collectGit call per associated
  // project, not per container/port.
  const collectMounts = collectDockerMountRecords
    ? (ids) => collectDockerMountRecords(ids, { platform, runCommand: runDockerMountsCommand })
    : null;
  const composeResolution = collectGit
    ? await collectGitForComposeProjects(dockerResult.containers, settings, {
      collectGit,
      scanCache,
      runGit,
      resolveIdentity,
      collectMounts,
      checkoutRootsByRepository,
    })
    : { byProjectName: new Map(), mountsByContainerId: new Map() };
  const composeProjectGit = composeResolution.byProjectName;
  // Placement runs as its own pass: it needs "which repository" answered before it can ask "which
  // of that repository's checkouts", and it inspects every stack rather than only the ones
  // repository resolution could not handle.
  if (collectGit) {
    await classifyComposeProjects(dockerResult.containers, composeProjectGit, {
      collectMounts,
      checkoutRootsByRepository,
      mountsByContainerId: composeResolution.mountsByContainerId,
    });
  }

  // instance -> the probe and app settings that produced it. Health is classified in a later pass
  // (association keys must be final first), and this carries the inputs across rather than having
  // that pass rebuild them from the flattened instance.
  const context = new Map();
  for (const item of pending) {
    const probe = probeHttp ? probes.get(item) : null;
    const docker = dockerByHostPort.get(item.listener.port) || null;
    // A container observation is independent confirmation the listener is a real service, so it
    // substitutes for a failed/inapplicable HTTP probe (e.g. Postgres) rather than being dropped
    // alongside actual noise (ControlCenter, Dropbox) that never got Docker corroboration either.
    if (probeHttp && !probe && !docker) continue;
    const instance = toInstance({
      listener: item.listener,
      identity: item.identity,
      candidates: item.candidates,
      probe,
      cwd: item.cwd,
      git: gitByRoot.get(item.identity.projectRoot) || null,
      docker,
      // A docker-matched instance's host pid is always Docker Desktop's shared VM-proxy on macOS —
      // never the container's real process — so `ps`'s reading for it is meaningless and
      // per-container `docker stats` is used instead whenever a container observation exists.
      processMetrics: docker
        ? toDockerStatsFields(dockerStatsByContainerId.get(docker.containerId))
        : toProcessMetricsFields(processByPid.get(item.listener.pid)),
      // Only meaningful for host processes: a Docker instance's host pid is Docker Desktop's shared
      // proxy, so its ancestry describes Docker Desktop rather than whoever started the container.
      provenance: docker ? null : resolveProvenance(item.listener.pid, processByPid, { listenerPids }),
    });
    context.set(instance, { probe, appSettings: item.appSettings });
    instances.push(instance);
  }
  disambiguateAssociationKeys(instances);
  // After disambiguation, so the previous-health lookup uses each instance's final key.
  attachHealth(instances, { previousHealth, context, now });

  return { capabilities, warnings, instances, composeProjectGit };
}

// Decide checkout ownership for a whole Compose project from its bind mounts. The working_dir
// label can identify the repository, but does not prove which checkout supplies the stack's files:
// placing by it would put a shared database under whichever worktree started it, and
// `docker compose down` from that row would stop it for every checkout. Named volumes provide no
// checkout evidence.
//
// One matching checkout means owned; competing checkouts or no matching checkout means shared.
// Unmatched infrastructure mounts do not weaken a single match. No bind mounts means unverified,
// which renders with shared services while retaining the distinction between absent and conflicting
// evidence. A Compose project stays one unit because stopping it affects all its containers.
export function classifyComposeOwnership(mountPaths, checkoutRoots) {
  const paths = (mountPaths || []).filter(Boolean);
  const roots = (checkoutRoots || []).filter((r) => r && r.path);
  if (!paths.length) {
    return { ownership: "unverified", evidence: { kind: "none", checkoutPaths: [] } };
  }
  // A mount "lands in" a checkout when it is that directory or anything beneath it. Longest match
  // wins so a worktree nested under its parent clone is attributed to the worktree, not the clone.
  //
  // Compared on comparablePath, not the raw strings. The registry stores realpath-resolved checkout
  // roots (identity.mjs keeps rootIds reproducible for a directory however it was reached) while
  // Docker reports the unresolved path, so on macOS a checkout under /var, /tmp or /etc — all
  // symlinks into /private — otherwise fails every prefix test and the stack is declared `shared`
  // on nothing but a spelling difference. Evidence keeps the ORIGINAL root path: it is the checkout
  // as the rest of the system refers to it, and the tooltip should not show a rewritten path.
  const matched = new Map();
  for (const mountPath of paths) {
    const mount = comparablePath(mountPath);
    let best = null;
    let bestLength = 0;
    for (const root of roots) {
      const candidate = comparablePath(root.path);
      if (mount !== candidate && !mount.startsWith(`${candidate}/`)) continue;
      if (!best || candidate.length > bestLength) {
        best = root;
        bestLength = candidate.length;
      }
    }
    if (best) matched.set(best.rootId, best);
  }
  if (matched.size > 1) {
    return {
      ownership: "shared",
      evidence: { kind: "conflict", checkoutPaths: [...matched.values()].map((r) => r.path).sort() },
    };
  }
  if (matched.size === 1) {
    // Unmatched mounts alongside a single matched checkout do not weaken the finding. Real stacks
    // routinely bind infrastructure that belongs to no checkout — /var/run/docker.sock,
    // /etc/localtime, a log directory — and requiring EVERY mount to land inside the checkout would
    // classify most ordinary single-checkout stacks as shared. What matters is that exactly one
    // checkout's files are depended on and no second checkout competes for the stack.
    const [root] = matched.values();
    return { ownership: "owned", rootId: root.rootId, evidence: { kind: "bind-mount", checkoutPaths: [root.path] } };
  }
  // Mounts exist but resolve to no known checkout — the repository root itself, or a sibling path.
  // Positive evidence that the stack is not checkout-specific.
  return { ownership: "shared", evidence: { kind: "repo-root", checkoutPaths: [] } };
}

// Attach canonical repository fields alongside the existing identity contract. repositoryId is the
// portable git id (or opaque local id) for git/path roots; null for process-only observations. A
// worktree resolves to the same repositoryId as its primary clone (readGitRemote reads commondir)
// while keeping its own rootId so worktree-specific metadata is retained. Additive — existing
// consumers of {identity, identityKind, confidence, projectRoot, evidence} are unaffected.
function withRepositoryFields(identity) {
  return {
    ...identity,
    repositoryId: canonicalRepositoryId(identity),
    rootId: identity.projectRoot ? computeRootId(identity.projectRoot) : null,
  };
}

// Both sides of the placement comparison reduced to one spelling. Pure string work — no realpath()
// call, which would put a filesystem hit per mount per checkout on the poll's hot path and would
// still be wrong for a checkout that has since been deleted.
//
// /private is the only symlink collapsed, and only ahead of the three directories macOS actually
// links there. A general symlink resolver is not wanted: this must agree with what identity.mjs
// already stored, not discover new equivalences.
function comparablePath(value) {
  const collapsed = String(value).replace(/\/{2,}/g, "/");
  const unprefixed = collapsed.replace(/^\/private(?=\/(?:var|tmp|etc)(?:\/|$))/, "");
  const candidate = unprefixed || collapsed;
  // A trailing slash on a checkout root would make every prefix test fail against "root + /".
  return candidate.length > 1 ? candidate.replace(/\/+$/, "") : candidate;
}

// Resolve each Compose project's repository: explicit repoPath first, working_dir second, then
// bind mounts only when the first two fail. working_dir counts only when it reaches a `.git`:
// "process" is the resolver's no-repository fallback, and promoting it would make every stack
// started from a non-repo directory look resolved. Bind mounts must agree on one repository;
// otherwise leave it unresolved, and mark a match "auto-bind" because a bind source is weaker
// evidence than working_dir. Reuse the per-scan Git cache and return mounts for the ownership pass.
async function collectGitForComposeProjects(containers, settings, {
  collectGit,
  scanCache,
  runGit,
  resolveIdentity = resolveProjectIdentity,
  collectMounts = null,
  // repositoryId -> [{ rootId, path }]: every checkout the registry knows for a repository, which is
  // what a stack's bind mounts are tested against. Empty means placement degrades to "no checkout
  // claimed" rather than to a wrong one.
  checkoutRootsByRepository = new Map(),
}) {
  const workingDirByProjectName = new Map();
  for (const container of containers) {
    if (container.composeProject && container.workingDir && !workingDirByProjectName.has(container.composeProject)) {
      workingDirByProjectName.set(container.composeProject, container.workingDir);
    }
  }
  const composeProjectNames = new Set(containers.map((c) => c.composeProject).filter(Boolean));
  const byProjectName = new Map();
  const needMounts = new Set();
  await Promise.all(
    Array.from(composeProjectNames, async (name) => {
      const configured = settings?.composeProjects?.[name] || {};
      const configuredOwnership = configured.ownership || null;
      const repoPath = configured.repoPath || (configuredOwnership && configuredOwnership !== "shared" ? configuredOwnership : null);
      if (repoPath) {
        const identity = resolveIdentity(repoPath, "docker-compose");
        byProjectName.set(name, {
          git: await collectGit(repoPath, { scanCache, runGit }),
          repositoryId: canonicalRepositoryId(identity),
          // An explicit repoPath names one checkout, so retain its rootId for manual placement.
          rootId: identity.projectRoot ? computeRootId(identity.projectRoot) : null,
          // The checkout directory this stack resolved to. Carried so the caller can persist the
          // rootId -> path mapping for a repository whose only presence is containers — without it
          // such a repository is registered with no path, and its own stack then has no checkout to
          // be tested against.
          projectRoot: identity.projectRoot || null,
          resolvedFrom: "manual",
          configuredOwnership,
        });
        return;
      }
      const workingDir = workingDirByProjectName.get(name);
      if (!workingDir) {
        needMounts.add(name);
        return;
      }
      const identity = resolveIdentity(workingDir, "docker-compose");
      if (identity.identityKind === "process") {
        needMounts.add(name);
        return;
      }
      byProjectName.set(name, {
        git: await collectGit(workingDir, { scanCache, runGit }),
        repositoryId: canonicalRepositoryId(identity),
        rootId: identity.projectRoot ? computeRootId(identity.projectRoot) : null,
        projectRoot: identity.projectRoot || null,
        resolvedFrom: "auto",
        configuredOwnership,
      });
    }),
  );

  // Only projects the first two tiers could not resolve are inspected here, batched into a single
  // `docker inspect`. The ownership pass inspects the remaining containers and reuses these results.
  if (!collectMounts || needMounts.size === 0) return { byProjectName, mountsByContainerId: new Map() };
  const candidates = containers.filter((c) => needMounts.has(c.composeProject) && c.containerId);
  if (!candidates.length) return { byProjectName, mountsByContainerId: new Map() };
  const mountsByContainerId = await collectMounts(candidates.map((c) => c.containerId));

  await Promise.all(
    Array.from(needMounts, async (name) => {
      const roots = new Map();
      for (const container of candidates) {
        if (container.composeProject !== name) continue;
        for (const source of mountsByContainerId.get(container.containerId) || []) {
          const identity = resolveIdentity(source, "docker-compose");
          if (identity.identityKind === "process" || !identity.projectRoot) continue;
          const repositoryId = canonicalRepositoryId(identity);
          if (!repositoryId) continue;
          roots.set(repositoryId, identity.projectRoot);
        }
      }
      // Agreement guard: one repository or nothing. Containers resolving to different repositories
      // means at least one bind mount points somewhere unrelated to the project, and there is no
      // basis for choosing between them — reporting nothing is the correct-or-absent answer the
      // rest of this module gives, and a manual repoPath remains available.
      if (roots.size !== 1) return;
      const [[repositoryId, projectRoot]] = roots;
      byProjectName.set(name, {
        git: await collectGit(projectRoot, { scanCache, runGit }),
        repositoryId,
        rootId: computeRootId(projectRoot),
        projectRoot,
        resolvedFrom: "auto-bind",
        configuredOwnership: settings?.composeProjects?.[name]?.ownership || null,
      });
    }),
  );
  return { byProjectName, mountsByContainerId };
}

// Second pass: decide WHICH CHECKOUT each resolved stack belongs to.
//
// Runs after repository resolution because it needs the answer to "which repository" before it can
// ask "which of that repository's checkouts". Mounts are collected for EVERY compose project here,
// not only the ones repository resolution could not handle — a stack resolved from working_dir still
// needs its mounts inspected, because working_dir is exactly the signal that must not decide
// placement.
//
// The extra cost is one batched `docker inspect` covering every compose container, and only when
// Docker is present at all. Projects whose mounts were already fetched during resolution reuse them.
async function classifyComposeProjects(containers, byProjectName, {
  collectMounts,
  checkoutRootsByRepository,
  mountsByContainerId = null,
}) {
  if (!collectMounts || !byProjectName.size) return byProjectName;
  const containersByProject = new Map();
  for (const container of containers) {
    if (!container.composeProject || !container.containerId) continue;
    if (!byProjectName.has(container.composeProject)) continue;
    if (!containersByProject.has(container.composeProject)) containersByProject.set(container.composeProject, []);
    containersByProject.get(container.composeProject).push(container);
  }
  if (!containersByProject.size) return byProjectName;

  // Reuse anything the resolution pass already inspected; fetch only what is missing.
  let mounts = mountsByContainerId || new Map();
  const missing = [];
  for (const list of containersByProject.values()) {
    for (const container of list) if (!mounts.has(container.containerId)) missing.push(container.containerId);
  }
  if (missing.length) {
    const fetched = await collectMounts(missing);
    if (mounts === mountsByContainerId) mounts = new Map(mounts);
    for (const [id, paths] of fetched) mounts.set(id, paths);
  }

  for (const [name, resolved] of byProjectName) {
    // Manual ownership is an explicit placement statement and outranks every inferred signal,
    // including bind mounts. A manual repoPath remains owned by its configured checkout.
    if (resolved.configuredOwnership === "shared") {
      resolved.ownership = "shared";
      resolved.ownershipEvidence = { kind: "manual", checkoutPaths: [] };
      resolved.rootId = null;
      if (resolved.git) {
        const { root, provider } = resolved.git;
        resolved.git = { root, provider };
      }
      continue;
    }
    if (resolved.resolvedFrom === "manual") {
      resolved.ownership = "owned";
      resolved.ownershipEvidence = { kind: "manual", checkoutPaths: [resolved.projectRoot].filter(Boolean) };
      continue;
    }
    const mountPaths = [];
    for (const container of containersByProject.get(name) || []) {
      for (const source of mounts.get(container.containerId) || []) {
        if (!mountPaths.includes(source)) mountPaths.push(source);
      }
    }
    const roots = checkoutRootsByRepository.get(resolved.repositoryId) || [];
    const verdict = classifyComposeOwnership(mountPaths, roots);
    resolved.ownership = verdict.ownership;
    resolved.ownershipEvidence = verdict.evidence;
    // Only owned stacks carry a checkout rootId; shared and unverified stacks must not inherit
    // checkout placement from the working_dir used during repository resolution.
    resolved.rootId = verdict.ownership === "owned" ? verdict.rootId : null;
    // Shared stacks retain repository-level root/provider data, but branch, HEAD, dirty state,
    // and ahead/behind describe a single checkout and cannot be claimed here.
    if (verdict.ownership !== "owned" && resolved.git) {
      const { root, provider } = resolved.git;
      resolved.git = { root, provider };
    }
  }
  return byProjectName;
}

// Docker Desktop on macOS runs containers inside a Linux VM, so container PIDs are never
// comparable to host-side lsof PIDs — published host port is the only reliable correlation between
// a container and the listener it backs. A container with no published ports, or whose published
// port matches no discovered listener, never appears on any instance.
function indexDockerContainersByHostPort(containers) {
  const byHostPort = new Map();
  for (const container of containers) {
    for (const { hostPort } of container.publishedPorts) {
      if (!byHostPort.has(hostPort)) {
        byHostPort.set(hostPort, {
          containerId: container.containerId,
          name: container.name,
          image: container.image,
          composeProject: container.composeProject,
          composeService: container.composeService,
          state: container.state,
        });
      }
    }
  }
  return byHostPort;
}

// Instance records already carry pid/ppid/command via `process`; only the metrics `ps` doesn't
// overlap with are surfaced here, and only when that PID actually answered (exited-before-`ps`-ran
// PIDs are simply absent from processByPid, never backfilled with a fabricated reading).
function toProcessMetricsFields(metrics) {
  if (!metrics) return null;
  return {
    cpuPercent: metrics.cpuPercent,
    // `ps pcpu` on macOS is already a share of total machine capacity, not of one core, so the
    // per-core and whole-machine figures are the same number for a native process.
    cpuPercentOfHost: metrics.cpuPercent,
    residentMemoryKb: metrics.residentMemoryKb,
    elapsedSeconds: metrics.elapsedSeconds,
  };
}

// `docker stats` carries no uptime field (see docker-stats.mjs) — elapsedSeconds stays null rather
// than reusing the host-proxy `ps` reading, which would silently reintroduce the same
// shared-PID-across-containers bug this provider exists to fix.
function toDockerStatsFields(stats) {
  if (!stats) return null;
  return {
    cpuPercent: stats.cpuPercent,
    // Percent of the whole machine. Carried separately because only this figure can be summed
    // across a project's containers — see docker-stats.mjs.
    cpuPercentOfHost: stats.cpuPercentOfHost ?? null,
    residentMemoryKb: stats.residentMemoryKb,
    elapsedSeconds: null,
  };
}

function appSettingsForIdentity(settings, identity) {
  const resolvedIdentity = settings ? resolveProjectAlias(settings, identity) : identity;
  const project = settings?.projects?.[resolvedIdentity];
  if (!project) return null;
  return project.apps?.web || Object.values(project.apps || {})[0] || null;
}

async function probeCandidatesForInstances(items, probeHttp, warnings, concurrency) {
  const results = new Map();
  let next = 0;
  async function worker() {
    for (;;) {
      const index = next++;
      if (index >= items.length) return;
      const item = items[index];
      for (const candidate of item.candidates) {
        try {
          const result = await probeHttp(candidate);
          if (result?.http === true) {
            results.set(item, { ...result, origin: candidate.origin });
            break;
          }
        } catch (err) {
          warnings.push(`probe failed for ${candidate.origin}: ${err.message}`);
        }
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(Math.max(1, concurrency), items.length) }, worker));
  return results;
}
