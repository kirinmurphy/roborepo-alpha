// Small, isolated roots for package-source checks. A "mini app root" holds the CLI and manifests
// but an empty globals/packages, plus whatever fixture packages a check writes, so a catalog load
// inside it sees a handful of packages instead of the shipped library.
// Every root lives under one temp directory that the caller removes.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

export function makeSourceRoots(prefix = "roborepo-package-sources-") {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const appRoot = path.join(tmp, "app");
  const home = path.join(tmp, "home");
  const workspace = path.join(tmp, "workspace");
  fs.mkdirSync(path.join(appRoot, "globals", "packages"), { recursive: true });
  // The CLI loads command modules relative to appRoot, so a spawned CLI needs scripts/ and modules/.
  for (const entry of ["manifests", "scripts", "modules", path.join("globals", "harnesses"), path.join("globals", "system")]) {
    fs.cpSync(path.join(repoRoot, entry), path.join(appRoot, entry), { recursive: true });
  }
  fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
  fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
  fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
  fs.writeFileSync(path.join(home, ".codex", "config.toml"), "");
  fs.mkdirSync(path.join(workspace, "packages"), { recursive: true });
  const stateRoot = path.join(home, ".roborepo");
  const env = {
    ...process.env,
    HOME: home,
    ROBOREPO_APP_ROOT: appRoot,
    ROBOREPO_STATE_ROOT: stateRoot,
    ROBOREPO_WORKSPACE_ROOT: workspace,
    ROBOREPO_MODE: "development",
    SKIP_MCP: "1",
  };
  return {
    tmp,
    appRoot,
    home,
    workspace,
    stateRoot,
    env,
    builtInDir: path.join(appRoot, "globals", "packages"),
    workspaceDir: path.join(workspace, "packages"),
    cleanup: () => fs.rmSync(tmp, { recursive: true, force: true }),
  };
}

// A package with one Claude rules fragment, so "applied" is visible as a heading in CLAUDE.md.
export function writeRulesPackage(packagesDir, id, config = {}) {
  const dir = path.join(packagesDir, id);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "rules.md"), `## Fixture rules ${id}${config.marker ? ` ${config.marker}` : ""}\n`);
  const { marker, ...rest } = config;
  fs.writeFileSync(path.join(dir, "package.config.json"), JSON.stringify({
    schemaVersion: 1,
    id,
    label: `Fixture ${id}`,
    description: `Fixture package ${id}.`,
    presentation: { category: "integrations" },
    resources: [{ type: "rules", harness: "claude", source: "rules.md" }],
    ...rest,
  }, null, 2));
  return dir;
}

export function writeReplaceOverride(workspace, ids) {
  const dir = path.join(workspace, "overrides");
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, "resources.json"), JSON.stringify({
    schemaVersion: 1,
    overrides: ids.map((id) => ({ type: "package", id, mode: "replace" })),
  }));
}

// Runs `body` (an async function body with the named modules in scope) in a child process under
// `env`, because the CLI resolves its roots from the environment once, at import time.
export function runModules(env, modules, body) {
  const imports = Object.entries(modules)
    .map(([name, rel]) => `const ${name} = await import(${JSON.stringify(path.join(env.ROBOREPO_APP_ROOT || repoRoot, rel))});`)
    .join("\n");
  const script = `${imports}\nconst __result = await (async () => { ${body} })();\nconsole.log(JSON.stringify(__result));`;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", script], { env, encoding: "utf8" });
  if (result.status !== 0) return { ok: false, error: `${result.stderr}${result.stdout}`.trim() };
  const lines = result.stdout.trim().split("\n");
  return { ok: true, value: JSON.parse(lines.at(-1)), stdout: result.stdout };
}

export function runCli(env, args, { input = "" } = {}) {
  const cli = path.join(env.ROBOREPO_APP_ROOT || repoRoot, "scripts/cli/main.mjs");
  const result = spawnSync(process.execPath, [cli, ...args], { env, encoding: "utf8", input });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr, output: `${result.stdout}${result.stderr}` };
}

export function liveClaudeRules(home) {
  try {
    return fs.readFileSync(path.join(home, ".claude", "CLAUDE.md"), "utf8");
  } catch {
    return "";
  }
}
