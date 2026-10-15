// Development fixtures (local/dev-fixtures) register repositories with deliberately unfetchable
// github.com/example remotes and a `-fixture` repository suffix. They exist to exercise Runtime and
// the registry, not to be product data, so every reader of the registry drops them unless
// `roborepo dev start` has switched dev mode on.
//
// Dev mode is a marker file in the state root rather than a process flag: `dev start` adopts a
// healthy portal that is already running, which a startup flag could never reach.
import fs from "node:fs";
import path from "node:path";

// The suffix matters: the development checkout itself also uses an example.com remote in tests and
// must remain a real repository.
const FIXTURE_REPOSITORY_PATTERN = /^git:github\.com\/example\/.+-fixture$/;

export function isFixtureRepository(repositoryId) {
  return typeof repositoryId === "string" && FIXTURE_REPOSITORY_PATTERN.test(repositoryId);
}

function devModeMarkerPath(stateRoot) {
  return path.join(stateRoot, "repositories", "dev-fixtures-enabled");
}

export function devFixturesEnabled({ stateRoot, fsApi = fs } = {}) {
  try {
    fsApi.statSync(devModeMarkerPath(stateRoot));
    return true;
  } catch {
    return false;
  }
}

// `roborepo dev start` turns this on and `roborepo dev stop` turns it off.
export function setDevFixturesEnabled({ stateRoot, enabled, fsApi = fs }) {
  const marker = devModeMarkerPath(stateRoot);
  if (enabled) {
    fsApi.mkdirSync(path.dirname(marker), { recursive: true });
    fsApi.writeFileSync(marker, "");
  } else {
    fsApi.rmSync(marker, { force: true });
  }
}

// A copy of `registry` without the fixture records and the aliases that point at them. Readers use
// this; writers must keep the unfiltered registry, or saving it would erase the fixtures.
export function withoutFixtureRepositories(registry) {
  const repositories = Object.fromEntries(
    Object.entries(registry.repositories || {}).filter(([id]) => !isFixtureRepository(id)),
  );
  if (Object.keys(repositories).length === Object.keys(registry.repositories || {}).length) return registry;
  const aliases = Object.fromEntries(
    Object.entries(registry.aliases || {}).filter(([from, to]) => !isFixtureRepository(from) && !isFixtureRepository(to)),
  );
  return { ...registry, repositories, aliases };
}
