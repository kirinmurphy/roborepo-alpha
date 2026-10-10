#!/usr/bin/env node
import assert from "node:assert/strict";
import {
  discoverInstances,
  classifyComposeOwnership,
} from "../../modules/developer-runtime/index.mjs";

// A Compose-labeled container with a published port, so `discoverInstances`'s Docker-corroboration
// path keeps the listener even though there's no lsof/HTTP-probe data behind it in these tests.
const composeContainer = ({ workingDir = null, project = "myapp" } = {}) => ({
  containerId: "abc123",
  name: "myapp-web-1",
  image: "myapp-web",
  state: "running",
  composeProject: project,
  composeService: "web",
  workingDir,
  publishedPorts: [{ hostPort: 15432, containerPort: 5432, protocol: "tcp" }],
});

// Minimal lsof output for a listener on the container's published host port, so the instance
// survives discovery's per-listener pass and Docker enrichment has something to attach to.
const lsofRecord = {
  pid: 999,
  command: "com.docker.backend",
  address: "*",
  port: 15432,
  bindScope: "wildcard",
};

const baseOptions = {
  platform: "darwin",
  probeHttp: null, // Docker corroboration alone is enough to keep the instance; no HTTP probing needed for these cases.
  collectGit: async (root) => ({ root, branch: "main", dirty: false, provider: { ok: true, reason: null } }),
  runGit: async () => ({ stdout: "" }),
  collectProcess: async () => new Map(),
  // Off by default so the existing working_dir/manual cases can never reach a real `docker inspect`;
  // the bind-mount cases below opt in explicitly.
  collectDockerMountRecords: null,
  discoverListenerRecords: undefined, // not an option of discoverInstances; left out intentionally
};

// discoverInstances doesn't take `discoverListenerRecords` as an override — it always calls the
// real one, driven by `runCommand`. Fixture-match on the lsof-style args it issues so the listener
// on port 15432 resolves without a real `lsof` binary.
async function runCommand(command, args) {
  if (command === "lsof" && args.includes("-iTCP")) {
    return { stdout: `p999\nc${lsofRecord.command}\nn*:${lsofRecord.port}` };
  }
  if (command === "lsof") {
    return { stdout: "" }; // per-pid cwd lookup — no cwd, so identity falls back to process-level
  }
  throw new Error(`unexpected runCommand invocation: ${command} ${args.join(" ")}`);
}

// Case 1: no manual repoPath, working_dir resolves to a real repo (identityKind "git"/"path") ->
// resolvedFrom "auto".
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/repo/myapp" })] }),
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    settings: { composeProjects: {} },
  });
  const entry = result.composeProjectGit.get("myapp");
  assert.equal(entry?.resolvedFrom, "auto");
  assert.equal(entry?.repositoryId, "git:github.com/x/myapp");
}

// Case 2: manual repoPath set AND working_dir present -> resolvedFrom "manual", and the
// working_dir path is never even attempted.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/should/not/be/used" })] }),
    resolveIdentity: (cwd) => {
      if (cwd === "/should/not/be/used") throw new Error("working_dir must not be resolved when a manual repoPath is set");
      if (cwd === "/repo/myapp-manual") {
        return { identity: "git:github.com/x/myapp-manual", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp-manual", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    settings: { composeProjects: { myapp: { repoPath: "/repo/myapp-manual" } } },
  });
  const entry = result.composeProjectGit.get("myapp");
  assert.equal(entry?.resolvedFrom, "manual");
  assert.equal(entry?.repositoryId, "git:github.com/x/myapp-manual");
}

// Case 2b: manual ownership can mark a stack shared even when working_dir points at a checkout.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/repo/myapp" })] }),
    collectDockerMountRecords: async () => new Map([["abc123", ["/repo/myapp/data"]]]),
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    checkoutRootsByRepository: new Map([["git:github.com/x/myapp", [{ rootId: "root-main", path: "/repo/myapp" }]]]),
    settings: { composeProjects: { myapp: { ownership: "shared" } } },
  });
  const entry = result.composeProjectGit.get("myapp");
  assert.equal(entry?.ownership, "shared");
  assert.equal(entry?.ownershipEvidence.kind, "manual");
  assert.equal(entry?.rootId, null);
}

// Case 3: working_dir resolves to identityKind "process" (no .git found anywhere in its
// ancestry) -> composeProjectGit has no entry for this project at all, since resolveProjectIdentity
// never fails outright and "process" is its safe no-repo-found fallback, not a real resolution.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/tmp/not-a-repo" })] }),
    resolveIdentity: (cwd) => ({ identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" }),
    settings: { composeProjects: {} },
  });
  assert.equal(result.composeProjectGit.has("myapp"), false);
}

// Bind-mount tier. A project with NO working_dir label (Supabase CLI starts its containers outside
// `docker compose up`, so Compose never writes one) still resolves when a container bind-mounts a
// path inside the repo — the walk-up from that path finds the same `.git`.
{
  let inspected = null;
  let inspectCalls = 0;
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: null })] }),
    collectDockerMountRecords: async (ids) => {
      inspectCalls += 1;
      inspected = ids;
      return new Map([["abc123", ["/repo/myapp/supabase/snippets"]]]);
    },
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp/supabase/snippets") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    settings: { composeProjects: {} },
  });
  const entry = result.composeProjectGit.get("myapp");
  assert.equal(entry?.resolvedFrom, "auto-bind");
  assert.equal(entry?.repositoryId, "git:github.com/x/myapp");
  // git context is collected against the repo ROOT, not the mounted subdirectory.
  assert.equal(entry?.git?.root, "/repo/myapp");
  assert.deepEqual(inspected, ["abc123"]);
  assert.equal(inspectCalls, 1, "placement reuses mounts fetched during repository resolution");
}

// Agreement guard: two containers in one project whose bind mounts resolve to DIFFERENT
// repositories means at least one mount points somewhere unrelated, and there is no basis for
// picking between them — resolve nothing rather than guess.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({
      warnings: [],
      containers: [
        composeContainer({ workingDir: null }),
        { ...composeContainer({ workingDir: null }), containerId: "def456", publishedPorts: [] },
      ],
    }),
    collectDockerMountRecords: async () => new Map([
      ["abc123", ["/repo/myapp/sub"]],
      ["def456", ["/repo/unrelated/sub"]],
    ]),
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp/sub") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      if (cwd === "/repo/unrelated/sub") {
        return { identity: "git:github.com/x/unrelated", identityKind: "git", confidence: "high", projectRoot: "/repo/unrelated", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    settings: { composeProjects: {} },
  });
  assert.equal(result.composeProjectGit.has("myapp"), false);
}

// Several containers agreeing on ONE repository is the normal Supabase shape (only some containers
// bind-mount anything at all) and still resolves.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({
      warnings: [],
      containers: [
        composeContainer({ workingDir: null }),
        { ...composeContainer({ workingDir: null }), containerId: "def456", publishedPorts: [] },
      ],
    }),
    collectDockerMountRecords: async () => new Map([
      ["abc123", ["/repo/myapp/a"]],
      ["def456", ["/repo/myapp/b"]],
    ]),
    resolveIdentity: (cwd) => {
      if (cwd.startsWith("/repo/myapp/")) {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    settings: { composeProjects: {} },
  });
  assert.equal(result.composeProjectGit.get("myapp")?.resolvedFrom, "auto-bind");
}

// A bind mount that resolves to no repo at all (identityKind "process") is not promoted, same guard
// the working_dir tier applies.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: null })] }),
    collectDockerMountRecords: async () => new Map([["abc123", ["/var/cache/something"]]]),
    resolveIdentity: (cwd) => ({ identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" }),
    settings: { composeProjects: {} },
  });
  assert.equal(result.composeProjectGit.has("myapp"), false);
}

// Precedence: a working_dir that resolves still wins for REPOSITORY resolution — resolvedFrom stays
// "auto" and no second repository lookup happens.
//
// It no longer suppresses `docker inspect`, though. Placement (which CHECKOUT) is decided by bind
// mounts for every stack, including ones whose repository came from working_dir — that is the whole
// point of bind-mount placement, since working_dir answers "where was the command
// typed" rather than "what do these containers depend on". An earlier revision of this test asserted
// mounts were never inspected in this case; that guard was about cost, and it is superseded by the
// placement requirement.
{
  let mountsInspected = false;
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/repo/myapp" })] }),
    collectDockerMountRecords: async () => {
      mountsInspected = true;
      return new Map([["abc123", ["/repo/myapp/data"]]]);
    },
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    checkoutRootsByRepository: new Map([["git:github.com/x/myapp", [{ rootId: "root-main", path: "/repo/myapp" }]]]),
    settings: { composeProjects: {} },
  });
  const resolved = result.composeProjectGit.get("myapp");
  assert.equal(resolved?.resolvedFrom, "auto", "repository still resolved from working_dir");
  assert.equal(mountsInspected, true, "placement inspects mounts even when working_dir resolved");
  // One checkout, one stack: the common case must still place the stack inside that checkout.
  assert.equal(resolved.ownership, "owned");
  assert.equal(resolved.rootId, "root-main");
}

// A stack whose mounts span two checkouts of the same repository is shared, and carries no rootId —
// so `docker compose down` is never offered from a row that implies it belongs to one branch.
{
  const result = await discoverInstances({
    ...baseOptions,
    runCommand,
    discoverDocker: async () => ({ warnings: [], containers: [composeContainer({ workingDir: "/repo/myapp" })] }),
    collectDockerMountRecords: async () => new Map([["abc123", ["/repo/myapp/data", "/repo/wt/feature/data"]]]),
    resolveIdentity: (cwd) => {
      if (cwd === "/repo/myapp") {
        return { identity: "git:github.com/x/myapp", identityKind: "git", confidence: "high", projectRoot: "/repo/myapp", evidence: "Git remote" };
      }
      return { identity: `process:${cwd}:unknown`, identityKind: "process", confidence: "low", projectRoot: null, evidence: "process working directory" };
    },
    checkoutRootsByRepository: new Map([["git:github.com/x/myapp", [
      { rootId: "root-main", path: "/repo/myapp" },
      { rootId: "root-feature", path: "/repo/wt/feature" },
    ]]]),
    settings: { composeProjects: {} },
  });
  const resolved = result.composeProjectGit.get("myapp");
  assert.equal(resolved.ownership, "shared");
  assert.equal(resolved.ownershipEvidence.kind, "conflict");
  assert.equal(resolved.rootId, null, "a shared stack never claims a checkout");
}

// ---- Compose ownership classification ----
// Placement is decided by bind mounts only. working_dir still resolves WHICH REPOSITORY a stack
// belongs to, but must never decide WHICH CHECKOUT — a shared database started from whichever
// worktree you happened to be in would otherwise render under that worktree, and `docker compose
// down` from that row would stop the database every other checkout is using.
{
  const roots = [
    { rootId: "main", path: "/repo" },
    { rootId: "wt-a", path: "/repo/.worktrees/a" },
    { rootId: "wt-b", path: "/elsewhere/b" },
  ];

  // Configuration 1: named volumes only. An ABSENCE of evidence, not a finding — nothing here
  // supports any placement, so the stack is not asserted to belong to a checkout.
  const volumesOnly = classifyComposeOwnership([], roots);
  assert.equal(volumesOnly.ownership, "unverified");
  assert.equal(volumesOnly.evidence.kind, "none");
  assert.equal(volumesOnly.rootId, undefined, "unverified never claims a checkout");

  // Configuration 2: bind mounts landing in exactly one checkout. That checkout's files are a hard
  // dependency of the stack.
  const single = classifyComposeOwnership(["/elsewhere/b/db"], roots);
  assert.equal(single.ownership, "owned");
  assert.equal(single.evidence.kind, "bind-mount");
  assert.equal(single.rootId, "wt-b");

  // Configuration 3: mounts spanning two checkouts. A positive finding that the stack is not
  // checkout-specific, so it belongs at repository level rather than under either one.
  const conflict = classifyComposeOwnership(["/repo/.worktrees/a/x", "/elsewhere/b/y"], roots);
  assert.equal(conflict.ownership, "shared");
  assert.equal(conflict.evidence.kind, "conflict");
  assert.equal(conflict.rootId, undefined, "a shared stack never claims one checkout");
  assert.deepEqual(conflict.evidence.checkoutPaths, ["/elsewhere/b", "/repo/.worktrees/a"]);

  // Configuration 4: mounts resolving to the repository root itself, not to any checkout.
  const repoRoot = classifyComposeOwnership(["/repo/shared"], [{ rootId: "wt-a", path: "/repo/.worktrees/a" }]);
  assert.equal(repoRoot.ownership, "shared");
  assert.equal(repoRoot.evidence.kind, "repo-root");

  // A worktree nested under its parent clone is attributed to the worktree: longest match wins, or
  // every worktree under /repo would be swallowed by the main checkout.
  assert.equal(classifyComposeOwnership(["/repo/.worktrees/a/src"], roots).rootId, "wt-a");

  // Sibling-prefix trap: /repo-other must not count as being under /repo.
  const sibling = classifyComposeOwnership(["/repo-other/x"], [{ rootId: "main", path: "/repo" }]);
  assert.equal(sibling.ownership, "shared");
  assert.equal(sibling.evidence.kind, "repo-root");

  // THE regression that matters: one checkout, one stack — the overwhelmingly common case. This
  // must still render the stack inside that checkout, exactly as it does today.
  const common = classifyComposeOwnership(["/repo/db"], [{ rootId: "main", path: "/repo" }]);
  assert.equal(common.ownership, "owned");
  assert.equal(common.rootId, "main");

  // Infrastructure mounts alongside a checkout mount do not weaken the finding. This is the shape of
  // a real stack (traefik_vps on the dev machine): three binds inside the checkout plus
  // /var/run/docker.sock, /etc/localtime and a log dir. Requiring EVERY mount to land inside the
  // checkout classified it as shared, which is wrong — one checkout's files are the dependency and
  // no second checkout competes.
  const withInfra = classifyComposeOwnership(
    ["/elsewhere/b/traefik/traefik.yml", "/elsewhere/b/acme.json", "/var/run/docker.sock", "/etc/localtime"],
    roots,
  );
  assert.equal(withInfra.ownership, "owned");
  assert.equal(withInfra.rootId, "wt-b");

  // But infrastructure mounts alone — with nothing landing in any checkout — stay shared: there is
  // no checkout dependency to point at.
  const infraOnly = classifyComposeOwnership(["/var/run/docker.sock", "/etc/localtime"], roots);
  assert.equal(infraOnly.ownership, "shared");
  assert.equal(infraOnly.evidence.kind, "repo-root");

  // A checkout with no recorded path cannot be matched against and must not throw.
  assert.equal(classifyComposeOwnership(["/repo/db"], [{ rootId: "x", path: null }]).ownership, "shared");
  assert.equal(classifyComposeOwnership(null, null).ownership, "unverified");

  // The two sides of the comparison are spelled differently in production and must still meet.
  //
  // The registry stores realpath-resolved roots (/private/var/...) because rootIds have to be
  // reproducible for a directory however it was reached; Docker reports the unresolved path
  // (/var/...), and a compose file interpolating TMPDIR — which ends in "/" on macOS — adds a
  // doubled slash on top. Comparing raw strings made every checkout under /var, /tmp or /etc match
  // nothing, so its stack was declared `shared` on a spelling difference alone. Caught on the live
  // fixture, whose scratch repo lives in TMPDIR.
  const symlinked = [
    { rootId: "main", path: "/private/var/folders/ab/T/fixture" },
    { rootId: "wt", path: "/private/var/folders/ab/T/fixture-wt" },
  ];
  const spanning = classifyComposeOwnership(
    ["/var/folders/ab/T//fixture/data", "/var/folders/ab/T//fixture-wt/data", "/etc/localtime"],
    symlinked,
  );
  assert.equal(spanning.ownership, "shared");
  assert.equal(spanning.evidence.kind, "conflict");
  // Evidence reports the checkout as the rest of the system spells it, not the rewritten form.
  assert.deepEqual(spanning.evidence.checkoutPaths, [
    "/private/var/folders/ab/T/fixture",
    "/private/var/folders/ab/T/fixture-wt",
  ]);

  const symlinkedSingle = classifyComposeOwnership(["/var/folders/ab/T//fixture/data"], symlinked);
  assert.equal(symlinkedSingle.ownership, "owned");
  assert.equal(symlinkedSingle.rootId, "main");

  // Normalization must not invent matches. A mount that lands in no checkout is still shared, and
  // /private is only collapsed ahead of the directories macOS actually symlinks there — a literal
  // /private/data directory is a real path, not a spelling of /data.
  assert.equal(classifyComposeOwnership(["/etc/localtime"], symlinked).ownership, "shared");
  assert.equal(
    classifyComposeOwnership(["/private/data/x"], [{ rootId: "p", path: "/data" }]).ownership,
    "shared",
  );
  // Agreeing spellings keep working, in both directions.
  assert.equal(classifyComposeOwnership(["/private/var/a/app/x"], [{ rootId: "q", path: "/private/var/a/app" }]).ownership, "owned");
  assert.equal(classifyComposeOwnership(["/var/a/app/x"], [{ rootId: "r", path: "/var/a/app" }]).ownership, "owned");
  // A trailing slash on a stored root would otherwise fail every "root + /" prefix test.
  assert.equal(classifyComposeOwnership(["/Users/me/app/data"], [{ rootId: "s", path: "/Users/me/app/" }]).ownership, "owned");
}

console.log("ok: developer-runtime compose project identity resolution");
