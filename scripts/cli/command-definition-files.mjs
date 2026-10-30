import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "./roots.mjs";

const DEFINITION_SUFFIXES = [".command.json", "namespace.json"];

export function loadCommandDefinitions({ roots }) {
  return roots
    .flatMap((root) => definitionFiles({ dir: path.join(repoRoot, root) }))
    .map((filePath) => JSON.parse(fs.readFileSync(filePath, "utf8")));
}

function definitionFiles({ dir }) {
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const entryPath = path.join(dir, entry.name);
      if (entry.isDirectory()) return definitionFiles({ dir: entryPath });
      return isDefinitionFile(entry.name) ? [entryPath] : [];
    })
    .sort();
}

function isDefinitionFile(fileName) {
  return DEFINITION_SUFFIXES.some((suffix) => fileName.endsWith(suffix));
}
