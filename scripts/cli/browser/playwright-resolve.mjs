// Finds a Playwright install without ever installing one. RoboRepo ships no Playwright (it is a
// devDependency), so the provider looks first in the target project, then in a tool directory
// under the state root that only an approved install command fills.

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";
import { appRoot } from "../roots.mjs";

const PACKAGE_NAMES = ["playwright", "@playwright/test"];

export function toolsDir(stateRoot) {
  return path.join(stateRoot, "browser", "tools");
}

// Resolution order: the project's own Playwright (resolved from the scenario's directory, so a
// monorepo package finds its own), then the RoboRepo-managed tool directory. Returns null when
// neither has one; the caller reports that as `blocked` with installCommand().
export function resolvePlaywright({ fromDir, stateRoot }) {
  const candidates = [
    { source: "project", base: fromDir },
    { source: "roborepo", base: toolsDir(stateRoot) },
  ];
  for (const { source, base } of candidates) {
    const require = createRequire(path.join(base, "noop.js"));
    for (const packageName of PACKAGE_NAMES) {
      let manifestPath;
      try {
        manifestPath = require.resolve(`${packageName}/package.json`);
      } catch {
        continue;
      }
      const packageDir = path.dirname(manifestPath);
      const { version } = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
      return {
        source,
        packageName,
        packageDir,
        version,
        cliPath: path.join(packageDir, "cli.js"),
        load: () => loadModule(require.resolve(packageName)),
      };
    }
  }
  return null;
}

// The exact command an agent asks the user to approve. It installs into the tool directory only,
// never the target project's manifest or lockfile. The version is the one RoboRepo's own browser
// suite runs against, read from package.json so there is one place to bump it.
export function installCommand(stateRoot) {
  const dir = toolsDir(stateRoot);
  const cli = path.join(dir, "node_modules", "playwright", "cli.js");
  return `npm install --prefix ${quote(dir)} playwright@${pinnedVersion()} && node ${quote(cli)} install chromium`;
}

export function browserInstallCommand(playwright) {
  return `node ${quote(playwright.cliPath)} install chromium`;
}

// Chromium and ffmpeg live in Playwright's machine-wide browser cache, not in node_modules. Checking
// for the files answers "can this capture" without launching or downloading anything.
//
// A headless launch runs the headless shell, and recording runs ffmpeg, each at the exact revision
// that this playwright-core's browsers.json pins; a cached build of another revision does not
// count. The full browser's path is read only to locate the cache (it need not be installed).
export function browserBinaries(chromium, playwright) {
  const cacheRoot = cacheRootOf(chromium.executablePath());
  const pinned = pinnedRevisions(playwright.packageDir);
  const entries = cacheRoot && fs.existsSync(cacheRoot) ? fs.readdirSync(cacheRoot) : [];
  return {
    hasChromium: entries.includes(`chromium_headless_shell-${pinned["chromium-headless-shell"]}`),
    hasFfmpeg: entries.includes(`ffmpeg-${pinned.ffmpeg}`),
  };
}

function cacheRootOf(executable) {
  if (!executable) return null;
  for (let dir = path.dirname(executable); dir !== path.dirname(dir); dir = path.dirname(dir)) {
    if (/^chromium-\d+$/.test(path.basename(dir))) return path.dirname(dir);
  }
  return null;
}

// playwright-core sits beside the resolved package, or inside `playwright` when the project
// installed `@playwright/test`.
function pinnedRevisions(packageDir) {
  const requireFrom = (dir) => createRequire(path.join(dir, "noop.js"));
  let coreManifest;
  try {
    coreManifest = requireFrom(packageDir).resolve("playwright-core/package.json");
  } catch {
    const playwrightDir = path.dirname(requireFrom(packageDir).resolve("playwright/package.json"));
    coreManifest = requireFrom(playwrightDir).resolve("playwright-core/package.json");
  }
  const { browsers } = JSON.parse(fs.readFileSync(path.join(path.dirname(coreManifest), "browsers.json"), "utf8"));
  return Object.fromEntries(browsers.map((browser) => [browser.name, browser.revision]));
}

// The packages are CommonJS. Node's named-export detection does not see through their re-exports,
// so the API is read from whichever of the namespace or its default carries it.
async function loadModule(entryPath) {
  const namespace = await import(pathToFileURL(entryPath).href);
  return namespace.chromium ? namespace : namespace.default;
}

function pinnedVersion() {
  const manifest = JSON.parse(fs.readFileSync(path.join(appRoot, "package.json"), "utf8"));
  return String(manifest.devDependencies?.["@playwright/test"] || "latest").replace(/^[\^~]/, "");
}

function quote(value) {
  return /[\s"'$]/.test(value) ? JSON.stringify(value) : value;
}
