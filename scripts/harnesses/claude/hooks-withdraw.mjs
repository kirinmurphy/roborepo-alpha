// Claude's hooks.write adapter method (withdraw's blanket strip-all — see the "Disable vs.
// withdraw" section of discoverable-harness-provider-architecture-plan.md). Split out of
// index.mjs, which grew past this repo's 150-200 line file-size guidance once rootConfig/mcp/
// telemetry/transcripts were all added alongside this one large withdraw-specific function.

import fs from "node:fs";
import path from "node:path";
import { repoRoot } from "../../cli/roots.mjs";

const PACKAGE_DIRS = [
  path.join(repoRoot, "globals", "packages"),
  path.join(repoRoot, "globals", "packages-archived"),
];

// Ported from scripts/install/uninstall.sh's strip_package_hooks (characterization test:
// scripts/test/harness-hooks-write-remove-characterization-check.mjs). Strips BOTH package-
// injected hooks AND package-injected permission allow-entries from ~/.claude/settings.json in one
// atomic read/write pass — the bash original conflated the two for a single file write rather than
// two, and this keeps that exact behavior rather than splitting across capability groups (the
// permissions capability has no removal method of its own). "write" here means "removal semantics"
// per the plan's withdraw design, not a generic hook writer.
export function hooksWriteRemove({ homePath, dryRun = false } = {}) {
  const settingsPath = path.join(homePath, "settings.json");
  const paths = [];
  const warnings = [];

  let settings;
  try {
    settings = JSON.parse(fs.readFileSync(settingsPath, "utf8"));
  } catch (err) {
    if (err.code !== "ENOENT") warnings.push(`could not read ${settingsPath}: ${err.message}`);
    return { ok: true, changed: false, providerId: "claude", action: "hooks.write", paths, warnings };
  }

  const packages = PACKAGE_DIRS.flatMap((packagesDir) => {
    try {
      return fs.readdirSync(packagesDir, { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({ root: path.join(packagesDir, entry.name), file: path.join(packagesDir, entry.name, "package.config.json") }))
        .filter(({ file }) => fs.existsSync(file))
        .flatMap(({ root, file }) => {
          try {
            return [{ root, config: JSON.parse(fs.readFileSync(file, "utf8")) }];
          } catch {
            return [];
          }
        });
    } catch {
      return [];
    }
  });

  let changed = false;

  for (const { root, config: pkg } of packages) {
    for (const resource of pkg.resources || []) {
      if (resource.type !== "hooks" || resource.harness !== "claude") continue;
      const hooksFile = path.join(root, resource.source);
      if (!fs.existsSync(hooksFile)) continue;
      let fragment;
      try {
        fragment = JSON.parse(fs.readFileSync(hooksFile, "utf8"));
      } catch {
        continue;
      }
      const hooks = settings.hooks || {};
      for (const [event, entries] of Object.entries(fragment)) {
        const cmds = new Set(entries.map((e) => e.hooks?.[0]?.command).filter(Boolean));
        const existing = hooks[event] || [];
        const next = existing.filter((e) => {
          const cmd = e.hooks?.[0]?.command;
          if (cmd && cmds.has(cmd)) {
            changed = true;
            return false;
          }
          return true;
        });
        if (next.length === 0) delete hooks[event];
        else hooks[event] = next;
      }
      if (Object.keys(hooks).length === 0) delete settings.hooks;
      else settings.hooks = hooks;
    }
  }

  const toRemove = new Set(
    packages.flatMap(({ config: pkg }) => (pkg.resources || []).filter((c) => c.type === "permissions").flatMap((c) => c.allow || []))
  );
  const existingAllow = settings.permissions?.allow || [];
  const nextAllow = existingAllow.filter((p) => !toRemove.has(p));
  if (nextAllow.length !== existingAllow.length) {
    if (nextAllow.length === 0) delete settings.permissions;
    else settings.permissions = { ...settings.permissions, allow: nextAllow };
    changed = true;
  }

  if (!changed) {
    return { ok: true, changed: false, providerId: "claude", action: "hooks.write", paths, warnings };
  }

  if (dryRun) {
    return { ok: true, changed: false, providerId: "claude", action: "hooks.write", paths, warnings: [...warnings, `dry-run: would remove package hooks/permissions from ${settingsPath}`] };
  }

  fs.writeFileSync(settingsPath, `${JSON.stringify(settings, null, 2)}\n`);
  paths.push(settingsPath);
  return { ok: true, changed: true, providerId: "claude", action: "hooks.write", paths, warnings };
}
