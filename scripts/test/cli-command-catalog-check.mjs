#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { loadCommandCatalog, listCommandNodes, promotedRootEntries } from "../cli/command-catalog.mjs";
import { validateExecutions } from "../cli/command-executor.mjs";
import { renderHelp } from "../cli/help-renderer.mjs";
import { repoRoot } from "../cli/paths.mjs";
import { resolveCommand } from "../cli/command-resolver.mjs";

const catalog = loadCommandCatalog();
validateExecutions({ catalog });

assert.deepEqual(catalog.commandDefinitionRoots, ["manifests/platform/cli/command-definitions"]);
assert.equal(catalog.discoveryRoots, undefined);
assert.ok(catalog.nodes.package.children.dev, "package dev namespace composed");
assert.ok(catalog.nodes.config.children.rules.children["check-home"], "nested config rules command composed");

const executableNodes = listCommandNodes(catalog, { includeInternal: true })
  .filter(({ node }) => node.execution);
assert.ok(executableNodes.length > 20, "catalog exposes executable routes");
for (const { tokens, node } of executableNodes) {
  assert.ok(node.execution.adapter, `${tokens.join(" ")} has execution adapter`);
}

// A module-adapter command must point at a file that exists and exports the named function. Without
// this, renaming a CLI module leaves its manifest dangling and the command fails only when run.
for (const { tokens, node } of executableNodes) {
  const { adapter, module: modulePath, export: exportName } = node.execution;
  if (adapter !== "module") continue;
  const label = `roborepo ${tokens.join(" ")}`;
  const file = path.join(repoRoot, modulePath);
  assert.ok(fs.existsSync(file), `${label}: execution.module does not exist: ${modulePath}`);
  const source = fs.readFileSync(file, "utf8");
  const exported = new RegExp(`export\\s+(?:async\\s+)?(?:function\\s*\\*?\\s*|const\\s+|let\\s+|var\\s+|class\\s+)${exportName}\\b|export\\s*\\{[^}]*\\b${exportName}\\b[^}]*\\}`);
  assert.ok(exported.test(source), `${label}: ${modulePath} does not export ${exportName}`);
}

const rootHelp = renderHelp(catalog);
assert.match(rootHelp, /Primary commands:/);
assert.doesNotMatch(rootHelp, /skill render-commands/);
assert.doesNotMatch(rootHelp, /roborepo onboard/);
// `library` is the root-level front door for package management; `package manage` stays
// discoverable under the package namespace but is no longer promoted to root, so root help
// teaches one name for the workflow rather than two.
assert.match(rootHelp, /library/);
assert.doesNotMatch(rootHelp, /package manage/);
assert.equal(promotedRootEntries(catalog).length, 0);
// init leads the lifecycle vocabulary a new user reads first.
assert.match(rootHelp, /init/);
assert.ok(rootHelp.indexOf("init") < rootHelp.indexOf("web"));
assert.ok(rootHelp.indexOf("web") < rootHelp.indexOf("library"));
assert.ok(rootHelp.indexOf("library") < rootHelp.indexOf("update"));
assert.equal(catalog.nodes.web.execution.prependArgs, undefined);
assert.deepEqual(catalog.nodes.web.interactiveArgs, ["--detach"]);

// --- `library` and `package manage` are two entry points to one implementation. Sharing the
// packageLibrary execution preset makes divergence structurally impossible rather than a thing a
// future edit has to remember to keep in sync. ---
assert.deepEqual(
  catalog.nodes.library.execution,
  catalog.nodes.package.children.manage.execution,
  "library and package manage must resolve to identical execution",
);
assert.equal(catalog.nodes.library.execution.export, "presetsCommand");
assert.deepEqual(catalog.nodes.library.execution.prependArgs, ["onboard"]);

// --- init is a public root command; setup stays internal so it is never taught as a first-run step. ---
assert.equal(catalog.nodes.init.kind, "command");
assert.equal(catalog.nodes.init.execution.module, "scripts/cli/initialize.mjs");
assert.equal(catalog.nodes.setup.kind, "internal");

const packageHelp = renderHelp(catalog, catalog.nodes.package, ["package"]);
assert.match(packageHelp, /roborepo package - Manage and develop RoboRepo packages/);
assert.match(packageHelp, /package dev/);
assert.doesNotMatch(packageHelp, /telemetry status/);

const maintenanceHelp = renderHelp(catalog, catalog.nodes.maintenance, ["maintenance"]);
assert.match(maintenanceHelp, /maintenance doctor/);
assert.match(maintenanceHelp, /maintenance repair/);
assert.doesNotMatch(maintenanceHelp, /maintenance uninstall/);

assert.deepEqual(resolveCommand(catalog, ["help", "package", "dev"]), {
  kind: "help",
  node: catalog.nodes.package.children.dev,
  tokens: ["package", "dev"],
});
assert.deepEqual(resolveCommand(catalog, ["package", "dev", "--help"]), {
  kind: "help",
  node: catalog.nodes.package.children.dev,
  tokens: ["package", "dev"],
});
assert.deepEqual(resolveCommand(catalog, ["package", "dev", "help"]), {
  kind: "help",
  node: catalog.nodes.package.children.dev,
  tokens: ["package", "dev"],
});

// --- The plan-suite commands: `package status` is public; `plans validate`, `plans start`, and
// `plans stop-servers` stay internal (callable by suite skills, never browsable), and each forwards its trailing args. ---
assert.match(packageHelp, /package status/);
const packageStatus = resolveCommand(catalog, ["package", "status", "plan-write", "--json"]);
assert.equal(packageStatus.kind, "command");
assert.deepEqual(packageStatus.tokens, ["package", "status"]);
assert.deepEqual(packageStatus.args, ["plan-write", "--json"]);
assert.deepEqual(catalog.nodes.package.children.status.execution.prependArgs, ["status"]);
for (const [name, args] of [["validate", ["age4cm7r", "--json"]], ["start", ["age4cm7r", "--worktree", "w"]], ["stop-servers", ["age4cm7r", "--dry-run"]]]) {
  const node = catalog.nodes.plans.children[name];
  assert.equal(node.kind, "internal", `plans ${name} is internal`);
  assert.match(node.usage, new RegExp(`^roborepo plans ${name} `));
  const resolved = resolveCommand(catalog, ["plans", name, ...args]);
  assert.equal(resolved.kind, "command", `plans ${name} resolves`);
  assert.deepEqual(resolved.args, args, `plans ${name} forwards its arguments`);
  assert.deepEqual(node.execution.prependArgs, [name]);
}
assert.doesNotMatch(rootHelp, /plans validate|plans start|plans stop-servers/, "internal plans commands stay out of root help");

const removed = resolveCommand(catalog, ["watch", "code", "."]);
assert.equal(removed.kind, "removed");
assert.deepEqual(removed.replacement.replacement, ["index", "code", "--watch"]);
assert.equal(resolveCommand(catalog, ["onboard"]).kind, "removed");
assert.equal(resolveCommand(catalog, ["verify", "--verbose"]).kind, "removed");
assert.equal(resolveCommand(catalog, ["enable"]).kind, "removed");
assert.equal(resolveCommand(catalog, ["disable"]).kind, "removed");

const watch = resolveCommand(catalog, ["index", "code", ".", "--watch"]);
assert.equal(watch.kind, "command");
assert.deepEqual(watch.tokens, ["index", "code"]);
assert.deepEqual(watch.args, [".", "--watch"]);

const namespaceWithDefaultExecution = resolveCommand(catalog, ["config", "rules", "--check"]);
assert.equal(namespaceWithDefaultExecution.kind, "command");
assert.deepEqual(namespaceWithDefaultExecution.tokens, ["config", "rules"]);
assert.deepEqual(resolveCommand(catalog, ["config", "rules"]).kind, "menu");

// Availability gate: `dev` must be reachable here (a development checkout) and absent in package
// mode. Package mode is asserted in a SUBPROCESS because developmentMode is a module-level const
// evaluated at import — mutating process.env inside this already-loaded process would not change it,
// so an in-process assertion would silently test nothing.
assert.ok(catalog.nodes.dev, "top-level dev namespace composed in a development checkout");
assert.equal(catalog.nodes.dev.developmentOnly, true, "dev namespace is marked developmentOnly");
assert.equal(resolveCommand(catalog, ["dev"]).kind, "menu", "dev resolves in a development checkout");
assert.ok(catalog.nodes.package.children.dev, "package dev is a separate namespace from top-level dev");

{
  const probe = `
    import { loadCommandCatalog, childEntries, validateCommandCatalog } from ${JSON.stringify(path.join(repoRoot, "scripts/cli/command-catalog.mjs"))};
    import { resolveCommand } from ${JSON.stringify(path.join(repoRoot, "scripts/cli/command-resolver.mjs"))};
    import { developmentMode } from ${JSON.stringify(path.join(repoRoot, "scripts/cli/paths.mjs"))};
    const catalog = loadCommandCatalog();
    const listed = childEntries(catalog, { includeInternal: true }).map((entry) => entry.key);
    console.log(JSON.stringify({
      developmentMode,
      listed: listed.includes("dev"),
      resolved: resolveCommand(catalog, ["dev"]).kind,
      help: resolveCommand(catalog, ["help", "dev"]).kind,
      // Validation must still WALK developmentOnly nodes on every machine, or a malformed dev
      // definition that ships in the tarball would only ever fail on a maintainer's laptop.
      //
      // Proven by corrupting the dev node and requiring validation to reject it. Asserting the node
      // merely EXISTS would pass either way — it reads the raw tree rather than exercising the
      // traversal — so that version of this check stayed green with includeUnavailable removed.
      validationWalksDev: (() => {
        const corrupted = structuredClone(catalog);
        corrupted.nodes.dev.kind = "not-a-real-kind";
        try {
          validateCommandCatalog(corrupted);
          return false;
        } catch (error) {
          return /invalid node kind at dev/.test(error.message);
        }
      })(),
    }));
  `;
  const result = spawnSync(process.execPath, ["--input-type=module", "-e", probe], {
    encoding: "utf8",
    env: { ...process.env, ROBOREPO_MODE: "package" },
  });
  assert.equal(result.status, 0, `package-mode catalog probe failed: ${result.stderr}`);
  const observed = JSON.parse(result.stdout);
  assert.equal(observed.developmentMode, false, "probe did not actually enter package mode");
  assert.equal(observed.listed, false, "dev must not be listed in package mode");
  assert.equal(observed.resolved, "invalid", "dev must not resolve in package mode");
  assert.equal(observed.help, "invalid", "help dev must not resolve in package mode");
  assert.equal(
    observed.validationWalksDev,
    true,
    "validateCommandCatalog must traverse developmentOnly nodes in package mode (includeUnavailable)",
  );
}

{
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-permissions-home-"));
  const stateRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-permissions-state-"));
  const workspaceRoot = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-config-permissions-workspace-"));
  try {
    fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
    fs.mkdirSync(path.join(home, ".codex"), { recursive: true });
    fs.mkdirSync(path.join(home, ".gemini"), { recursive: true });
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
    fs.copyFileSync(
      path.join(repoRoot, "generated", "codex", "config.toml"),
      path.join(home, ".codex", "config.toml"),
    );

    const env = {
      ...process.env,
      HOME: home,
      ROBOREPO_MODE: "package",
      ROBOREPO_PRESETS_ONBOARD: "skip",
      ROBOREPO_STATE_ROOT: stateRoot,
      ROBOREPO_WORKSPACE_ROOT: workspaceRoot,
    };
    const initResult = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "init"], {
      encoding: "utf8",
      env,
    });
    assert.equal(
      initResult.status,
      0,
      `package-mode init must apply default config\nstdout:\n${initResult.stdout}\nstderr:\n${initResult.stderr}`,
    );
    const result = spawnSync(process.execPath, [path.join(repoRoot, "scripts", "cli", "main.mjs"), "config", "permissions"], {
      encoding: "utf8",
      cwd: workspaceRoot,
      env,
    });
    assert.equal(
      result.status,
      0,
      `config permissions must run in package mode without a dev checkout\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
    );
    assert.doesNotMatch(
      `${result.stdout}\n${result.stderr}`,
      /requires development checkout/,
      "config permissions must not dispatch to a development-checkout-only repoScript",
    );
    assert.match(
      fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"),
      /default_permissions = "managed-workspace"/,
      "package-mode config permissions writes Codex live permissions",
    );
    assert.match(
      fs.readFileSync(path.join(home, ".codex", "config.toml"), "utf8"),
      /"~\/\.worktrees\/roborepo" = true/,
      "package-mode config permissions includes appRoot plans-config workspace root from an arbitrary cwd",
    );
    assert.match(
      fs.readFileSync(path.join(home, ".claude", "settings.json"), "utf8"),
      /Read\(~\/\.ssh\/\*\*\)/,
      "package-mode config permissions writes Claude live permissions",
    );
    assert.ok(
      fs.existsSync(path.join(home, ".claude", "hooks", "provider", "repo-write-scope.mjs")),
      "package-mode config permissions copies Claude hook scripts referenced by generated settings",
    );
    assert.ok(
      fs.existsSync(path.join(home, ".gemini", "policies", "generated-permissions.toml")),
      "package-mode config permissions writes Gemini live permissions",
    );
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
    fs.rmSync(stateRoot, { recursive: true, force: true });
    fs.rmSync(workspaceRoot, { recursive: true, force: true });
  }
}

const activeDocPaths = [
  "README.md",
  "docs/user/reference/roborepo-cli.md",
  "docs/internal/cli-internals.md",
  "docs/user/guides/setup-and-daily-use.md",
  "docs/user/guides/install-workflows.md",
  "docs/user/guides/first-time-setup.md",
  "docs/user/guides/telemetry.md",
  "docs/user/reference/jcodemunch.md",
  "docs/user/reference/jdocmunch.md",
  "docs/internal/portal-architecture.md",
  "docs/user/reference/plans-portal.md",
  "docs/user/reference/claude-hooks.md",
  "docs/user/reference/codex-hooks.md",
  "docs/user/reference/config-control-panel.md",
  "docs/user/reference/architecture.md",
  "docs/internal/harness-anatomy.md",
  "docs/architecture/documentation-map-and-audit.md",
  "docs/user/guides/plan/lifecycle/plan-suite.md",
  "local/skills/builtin-development/SKILL.md",
  "local/skills/builtin-development/references/package-development.md",
  "globals/system/skills/builtin-support/SKILL.md",
  "globals/packages/telemetry/package.config.json",
  "scripts/install/main.sh",
  "scripts/cli/config.mjs",
  "scripts/cli/package-probes.mjs",
  "scripts/cli/presets.mjs",
  "scripts/cli/telemetry.mjs",
  "scripts/cli/telemetry-seed-demo.mjs",
];
const removedCommandPattern = /cli (?:onboard|serve|verify|watch code|enable|disable)\b(?!-)(?!` was replaced)/;
for (const docPath of activeDocPaths) {
  const content = fs.readFileSync(path.join(repoRoot, docPath), "utf8");
  assert.doesNotMatch(content, removedCommandPattern, `${docPath} documents removed top-level package commands`);
}

console.log("cli-command-catalog-check passed");
