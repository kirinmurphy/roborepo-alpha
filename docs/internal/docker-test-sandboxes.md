# Docker Test Sandboxes

Docker tests in this repository are for machine-shape behavior: install, uninstall, package-mode
state, harness discovery, generated config projection, filesystem ownership, and other checks where
a redirected `HOME` is not isolated enough.

They are not a replacement for focused Node or shell tests. Use the smallest native test when the
behavior can be proven in-process. Use Docker when the behavior depends on a clean `PATH`, clean
home directory, package manager prefix, Linux filesystem semantics, or absence/presence of harness
binaries.

## Execution Model

Use one Docker image as a disposable machine template, then run a fresh container per scenario or
case. Do not maintain long-lived test VMs and do not try to clean a running container back to a
baseline between scenarios.

The scalable unit is:

1. Pack or prepare the repository artifact once on the host.
2. Start a container from the shared image.
3. Install or initialize once for the scenario.
4. Give each case its own `HOME`, state root, workspace root, npm prefix, npm cache, and `PATH`
   when the scenario has multiple cases.
5. Run all assertions that share that installed state.
6. Throw the container away.

This keeps failures attributable. If a scenario mutates shell profiles, npm bins, generated harness
config, or machine-local state, that mutation dies with the container.

The default scaling rule is **one package install per scenario, many assertions inside that
scenario**. Repeating `npm install` / `roborepo init` / `roborepo uninstall` for every assertion
does not scale. Do it only when install, initialization, or uninstall lifecycle behavior is itself
the thing being tested.

## Image Policy

Default to the current Node LTS slim image used by the clean-machine runner:

```text
node:22-bookworm-slim
```

The runner may allow an override for debugging or future matrix work, but tests should not rely on
host-installed tools beyond Docker itself. Keep `--network=none` for scenarios that install from a
locally packed tarball or otherwise should not fetch from the network.

On macOS Docker Desktop, bind mounts from the per-user `/var/folders/...` temp tree can hang before
container creation. Put Docker-bound artifacts under `/tmp` unless a test has a reason to override
that root.

## Scenario Types

Use separate scripts when failure meaning differs.

| Scenario type | Proves | Example command |
| --- | --- | --- |
| Clean install | Packed package installs, initializes, doctors, uninstalls, then npm removes app files. Also covers package-mode state/workspace roots in unusual filesystem shapes (spaces, deep nesting, symlinks) | `npm run test:clean-machine-install-sandbox` |
| Permissions projection | Fake harness presence receives the expected rendered config and no over-broad permissions | `npm run test:clean-machine-permissions-sandbox` |
| Onboarding/init lifecycle | First-run states a redirected-HOME unit test cannot reach: installed-not-initialized, a harness home with no root config yet, an older-shaped state record, and state left by a real killed `init` | `npm run test:clean-machine-onboarding-sandbox` |
| Lifecycle ownership | Install/uninstall preserves user-owned state and removes only roborepo-owned state | dedicated lifecycle sandbox |
| Platform assumptions | Linux path, shell, case-sensitivity, or coreutils assumptions are valid | dedicated portability sandbox |

Do not put every assertion into the clean-install sandbox. It should stay narrow so package install
breakage is obvious. Add a new sandbox when the setup or failure mode is meaningfully different.

## Shared Runner Helper

New clean-machine scenarios should use `scripts/test/lib/docker-sandbox.mjs` instead of hand-rolling
Docker setup. The helper owns the common machine wrapper:

- `dockerSandboxConfig()` reads the shared environment contract.
- `requireDockerOrSkip({ label, image, strict })` probes Docker and skips locally when allowed.
- `withPackedPackage(async ({ packDest, tarballName }) => ...)` packs the current checkout once
  under a Docker-safe temp root and cleans it afterward.
- `runDockerScript({ label, packDest, script })` runs one shell script in a fresh
  `node:22-bookworm-slim` container with `--network=none`, streams output, and enforces a timeout.

Environment knobs:

| Variable | Default | Meaning |
| --- | --- | --- |
| `CLEAN_MACHINE_IMAGE` | `node:22-bookworm-slim` | Container image |
| `CLEAN_MACHINE_STRICT` | unset | `1` turns Docker/image absence into a hard failure |
| `CLEAN_MACHINE_TIMEOUT_MS` | `300000` | Per-container timeout |
| `CLEAN_MACHINE_PROBE_TIMEOUT_MS` | `5000` | Docker daemon/image probe timeout |
| `CLEAN_MACHINE_TMPDIR` | `/tmp` | Host temp root for Docker-bound pack artifacts |

Prefer one script per scenario family. `clean-machine-install-sandbox.mjs` owns package
install/uninstall behavior, including unusual state/workspace root shapes. `clean-machine-permissions-sandbox.mjs` owns fake-harness permission
projection assertions. `clean-machine-onboarding-sandbox.mjs` owns first-run/init-lifecycle machine
states that need a real install or a real interrupted process rather than a redirected `HOME` unit
test; per-harness detection/presentation correctness across the provider count matrix stays in
`clean-machine-container-check.mjs` rather than being duplicated per onboarding case. The older
`clean-machine-container-check.mjs` is the broad integration container from the mainline install
lifecycle work; keep it as the end-to-end install matrix, and put new narrow permission assertions
in the permission sandbox.

## Harness Stubs

For permissions and projection tests, prefer fake harness executables over real agent CLIs. A fake
harness should be enough to trigger roborepo's detection path and should write predictable config
under the scenario's clean `HOME`.

Permissions sandbox cases should assert the generated or applied files directly:

- Claude settings keep credential denies home-relative, such as `Read(~/.ssh/**)`.
- No tracked or projected permission rule contains a contributor's absolute home path.
- Repo scope is represented by hook wiring, not by `~/projects/**`.
- Codex keeps the coarse sandbox expression instead of receiving unsupported path-scope rules.
- Gemini names the write tools in exactly one rule, the `write-files` gate. Its Policy Engine has no
  path predicate, so `write-scope` and `repo-scope` must not add rules of their own.

Hook behavior can be tested by invoking hook scripts directly with JSON payloads inside the
container. That is still deterministic and does not require a real interactive harness session.
Invoke the hook through the command string the harness settings wire, not the file path, so the
assertion also covers the wiring.

Keep permissions projection assertions in one installed container whenever possible. Add more grep,
JSON, TOML, or hook-payload assertions to the existing scenario before adding another full
install/uninstall loop.

## Local And CI Behavior

Local Docker tests may skip when Docker is unavailable unless the script is in strict mode. CI must
run important Docker sandboxes in strict mode so Docker or container failures are hard failures.
`scripts/test/ci.sh` also fails, rather than skips, when Docker is unavailable on a Linux CI runner,
because that leg is the only place the suites run in CI.

Use clear phase output and a timeout around `docker run`. A sandbox that hangs silently is not a
useful verifier.