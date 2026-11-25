// Source adapters: one small object per source type, so the catalog composes sources instead of
// branching on where a package lives. The contract is deliberately narrow:
//
//   list()                         package entries the source offers right now
//   resolve(packageId)             immutable resolution metadata for one package
//   materialize(resolution, dir)   make a resolution usable locally; returns the package folder
//
// An entry is transport only: `{ sourceId, packageId, root, file, config, collection }`, where
// `config` is the raw package manifest. Validation is not the adapter's job; the catalog runs the
// same manifest validation on every entry whatever its source.
import fs from "node:fs";
import path from "node:path";
import { sourceDirectory } from "./package-sources.mjs";

export function createPackageSource({ id, kind, list, resolve, materialize }) {
  for (const [name, fn] of Object.entries({ list, resolve, materialize })) {
    if (typeof fn !== "function") throw new Error(`package source ${id}: adapter is missing ${name}()`);
  }
  return Object.freeze({ id, kind, list, resolve, materialize });
}

// Bundled and path sources: a folder whose subfolders are RoboRepo packages, used in place.
function directorySource(record) {
  const root = sourceDirectory(record);
  const list = () => packageDirectories(root).map((dir) => {
    const file = path.join(dir, "package.config.json");
    return { sourceId: record.id, packageId: path.basename(dir), root: dir, file, config: readManifest(file), collection: null };
  });
  return createPackageSource({
    id: record.id,
    kind: record.type,
    list,
    resolve(packageId) {
      const entry = list().find((candidate) => candidate.packageId === packageId);
      if (!entry) return null;
      return { sourceId: record.id, packageId, kind: "live", selector: null, resolved: entry.root };
    },
    // A live source is never copied: its folder is the installed package.
    materialize(resolution) {
      if (!fs.existsSync(path.join(resolution.resolved, "package.config.json"))) {
        throw new Error(`${resolution.sourceId}/${resolution.packageId}: ${resolution.resolved} no longer holds the package`);
      }
      return resolution.resolved;
    },
  });
}

const ADAPTERS = {
  bundled: directorySource,
  path: directorySource,
};

// Git sources register their adapter from package-source-git.mjs, which pulls in process and
// network code that a plain catalog read never needs.
export function registerSourceAdapter(type, factory) {
  ADAPTERS[type] = factory;
}

export function createSourceAdapter(record) {
  const factory = ADAPTERS[record.type];
  if (!factory) throw new Error(`package source ${record.id}: no adapter for type ${record.type}`);
  return factory(record);
}

function packageDirectories(root) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
    .map((entry) => path.join(root, entry.name))
    .filter((dir) => fs.existsSync(path.join(dir, "package.config.json")))
    .sort();
}

export function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`invalid package config: ${file}: ${err.message}`);
  }
}
