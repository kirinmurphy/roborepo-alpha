// Domain-neutral canonical repository identity. Runtime, Plans, Telemetry, Agent Config, and
// Doctor all import from here rather than owning their own resolver. Barrel re-export (mirrors
// modules/developer-runtime/index.mjs).

export {
  normalizeGitRemote,
  findProjectRoot,
  resolveProjectIdentity,
  canonicalRepositoryId,
  localRepositoryId,
  localRepositoryIdForRoot,
  realpathOf,
  rootId,
  resolveGitDir,
  mainCheckoutPath,
  providerUrlForRepositoryId,
} from "./identity.mjs";

export { createScanCache } from "./scan-cache.mjs";

export {
  GIT_TIMEOUT_MS,
  GIT_READONLY_COMMANDS,
  defaultRunGit,
  defaultRunGitSync,
  runGitProcess,
  runGitProcessSync,
} from "./git-exec.mjs";

export {
  collectBranchSyncFacts,
  parseBranchSyncOutput,
} from "./branch-sync.mjs";

export {
  GIT_NETWORK_TIMEOUT_MS,
  refreshRemote,
  pushBranchToUpstream,
} from "./git-remote-operations.mjs";

export {
  REGISTRY_VERSION,
  VISIBILITY_STATES,
  RESOLUTION_STATES,
  ACTIVITY_STATES,
  ENROLLMENT_DOMAINS,
  DISCOVERY_SOURCES,
  CONFIGURED_DISCOVERY_SOURCE,
  CONFIDENCE_LEVELS,
  defaultRegistry,
  validateRegistry,
  validateRepositoryRecord,
  newRepositoryRecord,
  safeRepositoryId,
  resolveRegistryAlias,
  assertAliasGraph,
} from "./schema.mjs";

export {
  URL_KEY_PATTERN,
  URL_KEY_MAX_LENGTH,
  validateRepositoryUrlKey,
  allocateRepositoryUrlKey,
  repositoryUrl,
} from "./url-key.mjs";

export {
  registryPathFor,
  loadRegistry,
  writeRegistry,
  updateRegistry,
  upsertRepository,
  repositoryIdForUrlKey,
  recordDiscovery,
  recordDiscoveryIfKnown,
  removeDiscoveries,
  registerLocalRoot,
  registerLocalRootPath,
  localRootPath,
  checkoutRootsFor,
  priorRepositoryForRoot,
  setEnrollment,
  hideRepository,
  forgetRepository,
  pinRepository,
  setAlias,
} from "./registry.mjs";

export {
  LIFECYCLE_STATES,
  AGE_OUT_MS,
  inspectCheckout,
  deriveLifecycle,
  lastSeenAtFor,
  ageOutCandidates,
  supersededBy,
  renamedInto,
} from "./lifecycle.mjs";

export {
  EVIDENCE_POLICY,
  evidencePolicy,
  associateResolved,
  associateLegacyHashes,
} from "./associations.mjs";

export {
  isEnrolled,
  enrollmentSourceId,
} from "./enrollment.mjs";

export {
  importDeveloperRuntimeAliases,
  canonicalizeDeveloperRuntimeIdentity,
} from "./migrate-developer-runtime.mjs";

export {
  repositoryScopedFinding,
  globalFinding,
  isRepositoryScoped,
} from "./findings.mjs";

export {
  repositorySummary,
  repositoryListPayload,
  repositoryDetailPayload,
} from "./summary.mjs";

export {
  DEFAULT_IGNORED_DIRECTORIES,
  DISCOVERY_MAX_DEPTH,
  DISCOVERY_MAX_REPOSITORIES,
  isRepositoryRoot,
  walkRepositoryRoots,
  classifySourcePath,
} from "./discovery-walk.mjs";

export {
  SOURCES_VERSION,
  AUTO_DISCOVERY_SOURCE_ID,
  AUTO_DISCOVERY_DEFAULT_ENABLED,
  SOURCE_KINDS,
  USER_SOURCE_KINDS,
  SOURCE_STATES,
  defaultSources,
  validateSources,
} from "./sources-schema.mjs";

export {
  sourcesPathFor,
  loadSources,
  writeSources,
  updateSources,
  findSource,
  autoDiscoverySource,
  isAutoDiscoveryEnabled,
  userSources,
  addSource,
  removeSource,
  setSourceEnabled,
  setSourceStatus,
  requireSource,
  sourceError,
} from "./sources.mjs";
