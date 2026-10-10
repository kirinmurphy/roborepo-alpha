#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

import { packTarball } from "./package-install-smoke/tarball.mjs";

// Clean-machine install/uninstall, run inside a container.
//
// WHY A CONTAINER AND NOT A REDIRECTED HOME. package-install-smoke.mjs already installs a real
// packed tarball into a sandboxed prefix, and test-install-collisions.sh already redirects HOME.
// Neither can produce the machine this exists to test: one where nothing roborepo has ever run,
// no harness executable is resolvable, and npm's global prefix is a real system location rather
// than a temp directory the test invented. A container supplies all three.
//
// WHAT IT CAUGHT. On a real clean Mac, `roborepo uninstall` left its own binary behind because
// npm's prefix was ~/.local — the same directory the shell installer writes to — and the remnant
// check reported npm's binary rather than letting npm remove it. Every existing test passed. The
// colliding-prefix case below is that machine shape, pinned.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const IMAGE = "node:22-bookworm-slim";
const PACKAGE = JSON.parse(fs.readFileSync(path.join(repoRoot, "package.json"), "utf8")).name;

if (!dockerAvailable()) {
  // Skip rather than fail: this is a supplementary suite, and a contributor without Docker should
  // still get a green local run. CI has Docker, so coverage is not silently lost there.
  console.log("skip: clean-machine container check (docker unavailable)");
  process.exit(0);
}

// The assertion this whole file exists for, written as an `if` rather than
// `! command -v roborepo` in an && chain: under `set -e` the chain's exit status is 0 whether or
// not the binary is found, which makes it read like an assertion while asserting nothing.
//
// `hash -r` first, and it is not optional. Bash caches command lookups per shell, and these
// scenarios invoke `roborepo` before uninstalling it — so the shell holds a hash entry for a path
// that no longer exists, and `command -v` happily reports it. Without this the check fails against
// a correct uninstall, which it did on the first run of this file.
const ASSERT_GONE = `
hash -r
if command -v roborepo >/dev/null 2>&1; then
  echo "FAIL: binary survived uninstall at $(command -v roborepo)" >&2
  exit 1
fi
if [ -e "$HOME/.roborepo/initialization.json" ]; then
  echo "FAIL: initialization marker survived uninstall" >&2
  exit 1
fi
`;

// Re-running the CLI after uninstall must not re-enter onboarding. Asserting the binary is gone is
// not the same claim: the user-visible symptom on the real machine was onboarding restarting, and a
// future regression could remove the binary from PATH while leaving a resolvable copy elsewhere.
const ASSERT_NO_REONBOARD = `
hash -r
if command -v roborepo >/dev/null 2>&1; then
  out="$(roborepo 2>&1 || true)"
  case "$out" in
    *nitializ*|*nboarding*)
      echo "FAIL: a surviving binary re-entered onboarding after uninstall" >&2
      exit 1 ;;
  esac
fi
`;

const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-clean-machine-"));
try {
  const { tarballName } = packTarball(repoRoot, sandbox);
  testDefaultPrefix(tarballName);
  testCollidingPrefix(tarballName);
  testHarnessCountMatrix(tarballName);
  console.log("clean-machine container checks passed");
} finally {
  fs.rmSync(sandbox, { recursive: true, force: true });
}

function dockerAvailable() {
  const probe = spawnSync("docker", ["info"], { stdio: "ignore" });
  return probe.status === 0;
}

// Runs a script inside a throwaway container with the packed tarball mounted read-only.
// --network=none: nothing here should reach a registry, and a test that silently starts doing so
// would be both slow and non-hermetic. It also proves the install works from the local artifact.
function inContainer(script, { tarballName }) {
  const result = spawnSync("docker", [
    "run", "--rm", "--network=none",
    "-v", `${sandbox}:/artifact:ro`,
    "-e", `TARBALL=/artifact/${tarballName}`,
    "-e", `PACKAGE=${PACKAGE}`,
    IMAGE,
    "bash", "-euo", "pipefail", "-c", script,
  ], { encoding: "utf8" });
  return result;
}

// Stage 0: a machine with no agent harness at all, npm's default prefix.
//
// Confirmed on real hardware 2026-08-22: install,
// init, and doctor all succeeded with zero harnesses installed. That is the one stage a development
// machine cannot produce, which is why it is asserted first here.
function testDefaultPrefix(tarballName) {
  const result = inContainer(`
    npm install -g "$TARBALL" >/dev/null 2>&1
    command -v roborepo >/dev/null || { echo "FAIL: install left no binary" >&2; exit 1; }

    for exe in claude codex gemini; do
      if command -v "$exe" >/dev/null 2>&1; then
        echo "FAIL: container unexpectedly exposes $exe" >&2; exit 1
      fi
    done

    roborepo init >/dev/null 2>&1 || { echo "FAIL: init failed with zero harnesses" >&2; exit 1; }
    roborepo doctor >/dev/null 2>&1 || { echo "FAIL: doctor failed with zero harnesses" >&2; exit 1; }

    roborepo uninstall --yes >/dev/null 2>&1 || true
    ${ASSERT_GONE}
    ${ASSERT_NO_REONBOARD}
    echo OK
  `, { tarballName });

  assertContainer(result, "default prefix: install, init, doctor, uninstall");
}

// The machine shape that actually broke: npm's prefix set to the same ~/.local the shell installer
// writes to, so both owners want ~/.local/bin/roborepo.
//
// SABOTAGE-VERIFIED 2026-08-23. Reverting BOTH halves of 778ac00 makes this fail with exactly the
// original symptom ("binary survived at the colliding prefix"). Reverting only the shell half
// (is_npm_owned_cli) does NOT fail, and that is by construction, not a gap worth closing here:
// check_no_active_remnants is the last statement in uninstall.sh, so it only sets the exit status,
// and with the CLI half intact the npm handoff is ungated and removes the binary anyway. This
// scenario asserts the binary is absent, which stays true. The shell half's own regression is
// testNpmOwnedCliIsNotARemnant in managed-uninstall-check.mjs, which asserts on the remnant
// report itself — the two tests cover the two halves, and neither covers both.
function testCollidingPrefix(tarballName) {
  const result = inContainer(`
    mkdir -p "$HOME/.local"
    npm config set prefix "$HOME/.local"
    export PATH="$HOME/.local/bin:$PATH"

    npm install -g "$TARBALL" >/dev/null 2>&1
    test -e "$HOME/.local/bin/roborepo" || { echo "FAIL: npm did not install to the colliding prefix" >&2; exit 1; }

    roborepo init >/dev/null 2>&1 || { echo "FAIL: init failed on a colliding prefix" >&2; exit 1; }
    roborepo uninstall --yes >/dev/null 2>&1 || true

    if [ -e "$HOME/.local/bin/roborepo" ]; then
      echo "FAIL: binary survived at the colliding prefix (the original bug)" >&2
      exit 1
    fi
    ${ASSERT_GONE}
    ${ASSERT_NO_REONBOARD}
    echo OK
  `, { tarballName });

  assertContainer(result, "colliding npm prefix: uninstall removes the npm-owned binary");
}

// Stages 1-N of infra-packaging-02's harness-count matrix. Discovery resolves executables through
// PATH, so each stage is reachable with stub executables — no hardware, and no real harness.
//
// Two halves, and both are asserted here. The LIFECYCLE half is that init/doctor/uninstall survive
// each harness count. The PRESENTATION half is what that plan's Verify column actually asks for:
// that discovery reports the harnesses that are really there, and that an N-provider machine is
// rendered from the provider registry rather than from Claude/Codex assumptions.
//
// `harness detected` is the surface asserted for presentation. It emits one tab-separated row per
// known provider (id, home, present, display name, root config path) straight from live filesystem
// discovery, and it is the row source the shell install/uninstall/repair/doctor scripts consume —
// so a regression here is a regression in every one of those. There is no `roborepo list` command;
// `harness list` and `harness detected` are the real ones.
function testHarnessCountMatrix(tarballName) {
  const stages = [
    { name: "1 - installed, never launched", stubs: ["claude"], homes: [] },
    { name: "2 - launched once", stubs: ["claude"], homes: [".claude"] },
    { name: "3 - two harnesses", stubs: ["claude", "codex"], homes: [".claude", ".codex"] },
    { name: "N - all registered providers", stubs: ["claude", "codex", "gemini"], homes: [".claude", ".codex", ".gemini"] },
  ];

  for (const stage of stages) {
    const makeStubs = stage.stubs.map((exe) => `
      printf '#!/bin/sh\\necho "${exe} 1.0.0"\\n' > "$HOME/stub-bin/${exe}"
      chmod +x "$HOME/stub-bin/${exe}"
    `).join("\n");
    const makeHomes = stage.homes.map((home) => `mkdir -p "$HOME/${home}"`).join("\n");

    // Presence is keyed on the harness HOME directory, not the executable: an installed-but-never
    // launched harness (stage 1) has no home yet, which is exactly the distinction stage 1 and
    // stage 2 exist to separate. Asserting the `present` column per stage is what makes those two
    // stages different tests rather than the same test run twice.
    const assertPresence = stage.stubs.map((exe) => {
      const present = stage.homes.includes(`.${exe}`) ? "1" : "0";
      return `
      row="$(roborepo harness detected | awk -F'\\t' -v id=${exe} '$1 == id')"
      [ -n "$row" ] || { echo "FAIL: harness detected omitted ${exe} entirely" >&2; exit 1; }
      got="$(printf '%s' "$row" | cut -f3)"
      [ "$got" = "${present}" ] || { echo "FAIL: ${exe} present=$got, expected ${present}" >&2; exit 1; }`;
    }).join("\n");

    // Stage N is the anti-hardcoding check: every registered provider must appear, including the
    // one that is neither Claude nor Codex. A registry-driven renderer passes this for free; a
    // hardcoded pair does not.
    const assertAllProviders = stage.name.startsWith("N")
      ? `
      for id in claude codex gemini; do
        roborepo harness detected | cut -f1 | grep -qx "$id" \\
          || { echo "FAIL: provider $id missing from an N-provider machine" >&2; exit 1; }
        roborepo harness list | cut -f1 | grep -qx "$id" \\
          || { echo "FAIL: provider $id missing from harness list" >&2; exit 1; }
      done`
      : "";

    const result = inContainer(`
      npm install -g "$TARBALL" >/dev/null 2>&1
      mkdir -p "$HOME/stub-bin"
      ${makeStubs}
      ${makeHomes}
      export PATH="$HOME/stub-bin:$PATH"

      roborepo init >/dev/null 2>&1 || { echo "FAIL: init failed" >&2; exit 1; }
      roborepo doctor >/dev/null 2>&1 || { echo "FAIL: doctor failed" >&2; exit 1; }

      # Presentation half: discovery must report this stage's machine, not a cached or assumed one.
      roborepo harness refresh >/dev/null 2>&1 || { echo "FAIL: harness refresh failed" >&2; exit 1; }
      ${assertPresence}
      ${assertAllProviders}

      roborepo uninstall --yes >/dev/null 2>&1 || true
      ${ASSERT_GONE}
      echo OK
    `, { tarballName });

    assertContainer(result, `harness matrix stage ${stage.name}`);
  }
}

function assertContainer(result, label) {
  assert.equal(
    result.status,
    0,
    `${label}\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  assert.match(result.stdout, /OK/, `${label}: container did not reach its final assertion`);
  console.log(`ok: ${label}`);
}
