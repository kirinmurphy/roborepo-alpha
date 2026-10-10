import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { assertCleanWorktree, packTarball, installTarball, smokeEnv } from "./package-install-smoke/tarball.mjs";
import {
  runCommand,
  assertVersionOutput,
  assertWorkspaceInitialized,
  assertPublicLifecycle,
  assertInstalledUninstallRemovesPackage,
} from "./package-install-smoke/command-assertions.mjs";
import { hashDirectory } from "./lib/hash-directory.mjs";
import {
  assertNoSourceCoupling,
  assertNoVersionedPathCoupling,
} from "./package-install-smoke/coupling-scan.mjs";
import { retainArtifact } from "./package-install-smoke/retain-artifact.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const packageName = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name;

const outputDirFlagIndex = process.argv.indexOf("--output-dir");
const outputDir = outputDirFlagIndex >= 0 ? process.argv[outputDirFlagIndex + 1] : null;
if (outputDirFlagIndex >= 0 && !outputDir) {
  throw new Error("--output-dir requires a value");
}

main();

function main() {
  if (outputDir) {
    assertCleanWorktree(repoRoot);
  }

  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-package-smoke-"));
  const dirs = {
    sandbox,
    packDest: path.join(sandbox, "pack"),
    prefix: path.join(sandbox, "prefix"),
    cache: path.join(sandbox, "cache"),
    home: path.join(sandbox, "home"),
    stateRoot: path.join(sandbox, "state"),
    workspaceRoot: path.join(sandbox, "workspace"),
    cwd: path.join(sandbox, "cwd"),
  };
  for (const dir of Object.values(dirs)) fs.mkdirSync(dir, { recursive: true });

  try {
    const env = smokeEnv(dirs);
    for (const harnessExe of ["claude", "codex", "gemini"]) {
      const probe = runCommand("sh", ["-c", `command -v ${harnessExe}`], dirs.cwd, env, { expectFailure: true });
      assert.notEqual(probe.status, 0, `smoke PATH unexpectedly exposes ${harnessExe}: ${probe.stdout}`);
    }
    const { tarballPath, tarballName } = packTarball(repoRoot, dirs.packDest);
    installTarball(dirs, tarballPath, env);

    const binPath = path.join(dirs.prefix, "bin", "roborepo");
    assert.ok(fs.existsSync(binPath), `expected installed binary at ${binPath}`);

    const appRoot = path.join(dirs.prefix, "lib", "node_modules", packageName);
    assert.ok(fs.existsSync(appRoot), `expected installed application root at ${appRoot}`);
    assert.ok(
      fs.existsSync(path.join(appRoot, "docs", "plans", "plans-config.json")),
      "package install must include plans-config.json for package-mode workspace-root derivation",
    );

    const hashBefore = hashDirectory(appRoot);

    const versionOut = runCommand(binPath, ["version"], dirs.cwd, env);
    assertVersionOutput(versionOut, appRoot);

    runCommand(binPath, ["setup"], dirs.cwd, env);
    assertWorkspaceInitialized(dirs.workspaceRoot);

    runCommand(binPath, ["workspace", "status"], dirs.cwd, env);
    runCommand(binPath, ["harness", "refresh"], dirs.cwd, env);
    runCommand(binPath, ["harness", "list"], dirs.cwd, env);

    // The smoke PATH starts with no supported harnesses so the fresh-install check above stays
    // meaningful. Add a tiny validated Claude fixture now so config apply exercises the
    // package-mode root-config update path without requiring Claude Code to be installed.
    const claudeHome = path.join(dirs.home, ".claude");
    fs.mkdirSync(claudeHome, { recursive: true });
    fs.writeFileSync(path.join(claudeHome, "settings.json"), "{}\n");
    fs.writeFileSync(
      path.join(dirs.sandbox, "tools", "claude"),
      "#!/bin/sh\nprintf 'Claude Code test fixture\\n'\n",
      { mode: 0o755 },
    );
    runCommand(binPath, ["harness", "refresh"], dirs.cwd, env);

    const applyOut = runCommand(binPath, ["config", "apply"], dirs.cwd, env);
    assert.match(applyOut.stdout, /updated root config/, `expected config apply to report updated root configs\n${applyOut.stdout}`);

    const doctorOut = runCommand(binPath, ["doctor"], dirs.cwd, env);
    assert.match(doctorOut.stdout, /doctor passed \(\d+ checks\)/, `expected doctor to pass\n${doctorOut.stdout}${doctorOut.stderr}`);

    // The public lifecycle surface this plan added (init / library / uninstall), exercised in
    // package mode. The sequence above is the lower-level primitive path and proved only that;
    // a user installing from npm types these instead, so package mode has to cover them too or
    // "runs in development mode" is the only thing actually verified.
    assertPublicLifecycle(binPath, dirs, env);

    const hashAfter = hashDirectory(appRoot);
    assert.equal(hashAfter, hashBefore, "appRoot must be byte-identical before and after runtime commands");

    const scanTargets = [
      { root: dirs.home, allowInstallStateExemption: true },
      { root: dirs.workspaceRoot, allowInstallStateExemption: false },
      { root: dirs.stateRoot, allowInstallStateExemption: true },
    ];
    for (const { root, allowInstallStateExemption } of scanTargets) {
      assertNoSourceCoupling(root, repoRoot);
      assertNoVersionedPathCoupling(root, dirs.prefix, packageName, { allowInstallStateExemption });
    }

    if (outputDir) {
      retainArtifact({ repoRoot, outputDir, tarballPath, tarballName });
    }

    assertInstalledUninstallRemovesPackage(binPath, dirs, env, packageName);

    console.log(`ok: package install smoke (${outputDir ? "retained" : "ephemeral"})`);
  } finally {
    fs.rmSync(sandbox, { recursive: true, force: true });
  }
}
