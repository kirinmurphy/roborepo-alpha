// The management dialog's payload: sources (with display paths) and one list of every known
// repository with a quiet "Found by" explanation. This is the only payload allowed to carry source
// paths (pljvmyh §6), and even here they are home-collapsed display strings.
import { AUTO_DISCOVERY_SOURCE_ID, CONFIGURED_DISCOVERY_SOURCE, autoDiscoverySource, userSources } from "../../modules/repositories/index.mjs";

const DISCOVERY_LABELS = {
  "developer-runtime": "auto-discovery",
  telemetry: "agent sessions",
  plans: "plans",
  agentConfig: "agent config",
  doctor: "doctor",
  manual: "added manually",
};

export function sourcesManagementPayload({ store, registry, homeDir }) {
  const auto = autoDiscoverySource(store);
  const labels = new Map(userSources(store).map((source) => [source.id, displayPath(source.path, homeDir)]));
  const records = Object.values(registry.repositories || {}).filter((record) => !registry.aliases?.[record.id]);
  const countFor = (predicate) => records.filter((record) => record.discoveries.some(predicate)).length;
  return {
    revision: store.revision,
    loadError: store.loadError || null,
    autoDiscovery: {
      id: AUTO_DISCOVERY_SOURCE_ID,
      enabled: auto?.enabled === true,
      repositoryCount: countFor((d) => d.source === "developer-runtime"),
    },
    sources: userSources(store).map((source) => ({
      id: source.id,
      kind: source.kind,
      displayPath: labels.get(source.id),
      enabled: source.enabled,
      status: {
        ...source.status,
        repositoryCount: countFor((d) => d.source === CONFIGURED_DISCOVERY_SOURCE && d.sourceId === source.id),
      },
    })),
    repositories: records
      .map((record) => ({
        repositoryId: record.id,
        urlKey: record.urlKey,
        displayName: record.displayName,
        visibility: record.visibility,
        pinned: record.pinned === true,
        foundBy: foundBy(record, labels),
      }))
      .sort((a, b) => a.displayName.localeCompare(b.displayName)),
  };
}

function foundBy(record, labels) {
  const out = [];
  for (const discovery of record.discoveries) {
    const label = discovery.source === CONFIGURED_DISCOVERY_SOURCE
      ? labels.get(discovery.sourceId) || "a removed folder"
      : DISCOVERY_LABELS[discovery.source] || discovery.source;
    if (!out.includes(label)) out.push(label);
  }
  return out;
}

export function displayPath(absolutePath, homeDir) {
  if (homeDir && (absolutePath === homeDir || absolutePath.startsWith(`${homeDir}/`))) return `~${absolutePath.slice(homeDir.length)}`;
  return absolutePath;
}
