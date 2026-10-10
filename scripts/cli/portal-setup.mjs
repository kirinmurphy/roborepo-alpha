// Path-free setup state shared by Settings and contextual onboarding. This module derives a view
// from domain-owned stores; it never writes state and deliberately omits repository source paths.
import path from "node:path";
import { isFixtureRepository } from "../../modules/developer-runtime/snapshot.mjs";
import { autoDiscoverySource, defaultSources, loadRegistry, loadSources, userSources } from "../../modules/repositories/index.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { configSnapshotMachineHarnesses } from "./config.mjs";
import { readJsonState } from "./state-paths.mjs";
import { STATE_ROOT as defaultStateRoot } from "./paths.mjs";
import { activePresentedHarnesses } from "../../portal/shared/harness-cohort.js";

export function loadSetupState({
  stateRoot = defaultStateRoot,
  loadRepositories = () => ({
    registry: loadRegistry({ stateRoot }),
    sources: loadSources({ stateRoot }),
  }),
  loadHarnesses = () => ({
    supported: listHarnessProviders().map((provider) => ({
      id: provider.id,
      displayName: provider.manifest.displayName,
    })),
    detected: configSnapshotMachineHarnesses(),
  }),
  loadTelemetry = () => readJsonState(path.join(stateRoot, "telemetry", "state.json"), { enabled: false }),
} = {}) {
  const { registry, sources } = loadRepositories();
  return buildSetupState({ registry, sources, ...loadHarnesses(), telemetry: loadTelemetry() });
}

export function buildSetupState({ registry = {}, sources = {}, supported = [], detected = [], telemetry = {} } = {}) {
  const records = Object.values(registry.repositories || {}).filter((record) =>
    !registry.aliases?.[record.id] && !isFixtureRepository(record.id));
  const visible = records.filter((record) => record.visibility !== "hidden");
  const sourceStore = sources?.sources ? sources : defaultSources();
  const auto = autoDiscoverySource(sourceStore);
  const harnesses = {
    supported: supported.map(safeHarness),
    detected: detected.map(safeHarness),
  };
  harnesses.active = activePresentedHarnesses({
    harnesses: harnesses.supported,
    machineHarnesses: harnesses.detected,
  }).map(safeHarness);
  return {
    repositories: {
      knownCount: records.length,
      visibleCount: visible.length,
      autoDiscoveryEnabled: auto?.enabled === true,
      hasConfiguredSources: userSources(sourceStore).length > 0,
    },
    harnesses,
    telemetry: {
      enabled: telemetry?.enabled === true,
      captureAvailable: telemetry?.enabled === true && harnesses.active.length > 0,
    },
  };
}

function safeHarness(harness) {
  return {
    id: harness.id,
    displayName: harness.displayName,
    ...(harness.confidence ? { confidence: harness.confidence } : {}),
    ...(typeof harness.enabled === "boolean" ? { enabled: harness.enabled } : {}),
  };
}
