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
// A headless launch runs the headless shell build of the same revision as the full browser, and
// only that. So the full browser's path is read just for its location and revision (it need not be
// installed), and Chromium counts as present when the matching headless shell is.
export function browserBinaries(chromium) {
  const location = chromiumLocation(chromium.executablePath());
  if (!location) return { hasChromium: false, hasFfmpeg: false };
  const entries = fs.existsSync(location.cacheRoot) ? fs.readdirSync(location.cacheRoot) : [];
  return {
    hasChromium: entries.includes(`chromium_headless_shell-${location.revision}`),
    hasFfmpeg: entries.some((name) => name.startsWith("ffmpeg")),
  };
}

function chromiumLocation(executable) {
  if (!executable) return null;
  let dir = path.dirname(executable);
  while (dir !== path.dirname(dir)) {
    const match = /^chromium-(\d+)$/.exec(path.basename(dir));
    if (match) return { cacheRoot: path.dirname(dir), revision: match[1] };
    dir = path.dirname(dir);
  }
  return null;
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
