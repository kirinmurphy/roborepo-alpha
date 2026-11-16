#!/usr/bin/env node
// The repo agent-config inspector against real Git checkouts: which checkout it reads, what Claude
// Code and Codex discovery finds, and what it must never do — read outside the checkout, follow a
// symlink, start a repo-configured process, write a file or Git metadata, or return a sensitive value.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import {
  defaultRegistry, upsertRepository, registerLocalRoot, registerLocalRootPath, rootId, normalizeGitRemote,
} from "../../modules/repositories/index.mjs";
import {
  loadRepositoryAgentConfig, loadRepositoryAgentConfigSource, selectPrimaryCheckout, INVENTORY_LIMITS,
} from "../cli/repository-agent-config.mjs";
import { listHarnessProviders } from "../harnesses/registry.mjs";
import { validateCapabilityAdapters } from "../harnesses/contract.mjs";
import { describeCodexProjectFile } from "../harnesses/codex/project-inventory.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-agent-config-")));
const marker = path.join(tmp, "process-ran");

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8" });
  if (result.status !== 0) throw new Error(`git ${args.join(" ")}: ${result.stderr}`);
  return result.stdout.trim();
}

function write(root, rel, content) {
  const file = path.join(root, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, content);
}

function makeRepo(name, files, { remote } = {}) {
  const root = path.join(tmp, name);
  fs.mkdirSync(root, { recursive: true });
  git(root, "init", "-q", "-b", "main");
  if (remote) git(root, "remote", "add", "origin", remote);
  for (const [rel, content] of Object.entries(files)) write(root, rel, content);
  git(root, "add", "-A");
  git(root, "commit", "-q", "--allow-empty", "-m", "init");
  return root;
}

// Every provider, none enabled on this "machine": discovery must not depend on enablement.
const runtime = {
  projectInventoryProviders: () => listHarnessProviders().map((provider) => ({
    provider, enabled: false, inventory: provider.adapters.projectInventory ?? null,
  })),
};

function registryWith(repositoryId, roots) {
  const registry = defaultRegistry();
  upsertRepository(registry, { id: repositoryId, kind: "git", displayName: repositoryId.split("/").at(-1) });
  for (const { path: rootPath, kind } of roots) {
    const id = rootId(rootPath || `${repositoryId}-${kind}-${Math.random()}`);
    registerLocalRoot(registry, repositoryId, { rootId: id, kind });
    if (rootPath) registerLocalRootPath(registry, repositoryId, { rootId: id, path: rootPath });
  }
  return registry;
}

const SECRETS = ["sk-live-SECRET-1", "https://evil.invalid/hook", "Bearer SECRET-2", "SECRET_ENV_VALUE", "rm -rf /tmp/never"];
const REMOTE = "https://github.com/acme/inspect-main.git";
const MAIN_ID = normalizeGitRemote(REMOTE);

try {
  // ------------------------------------------------------------------ the main fixture
  fs.writeFileSync(path.join(tmp, "outside.md"), "# Outside the checkout\n");
  const main = makeRepo("main-checkout", {
    "CLAUDE.md": "# Root instructions\n@AGENTS.md\n",
    "AGENTS.md": "# Codex root\n",
    "packages/api/AGENTS.md": "# Nested\n",
    "packages/api/AGENTS.override.md": "# Override\n",
    "packages/web/CLAUDE.md": "# Nested Claude\n",
    ".claude/rules/always.md": "# Always\n",
    ".claude/rules/scoped.md": "---\npaths:\n  - src/**\n---\n# Scoped\n",
    ".claude/skills/review/SKILL.md": "---\nname: review\ndescription: Reviews a diff.\n---\nBody\n",
    "packages/web/.claude/skills/nested-skill/SKILL.md": "---\nname: nested-skill\n---\n",
    ".agents/skills/codex-skill/SKILL.md": "---\nname: codex-skill\ndescription: A Codex skill.\n---\n",
    ".codex/skills/legacy-skill/SKILL.md": "---\nname: legacy-skill\n---\n",
    ".claude/settings.json": JSON.stringify({
      permissions: { allow: ["Bash(ls:*)"], deny: ["Read(.env)"], defaultMode: "acceptEdits" },
      hooks: { PreToolUse: [{ hooks: [{ type: "command", command: SECRETS[4] }] }], WeirdEvent: [] },
      env: { API_KEY: SECRETS[3] },
      apiKeyHelper: SECRETS[0],
    }),
    ".mcp.json": JSON.stringify({ mcpServers: {
      remote: { type: "http", url: SECRETS[1], headers: { Authorization: SECRETS[2] } },
      local: { command: "node", args: ["server.js"], env: { TOKEN: SECRETS[0] } },
      "bad name with spaces": { command: "x" },
    } }),
    ".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews.\n---\nPrompt\n",
    ".claude/commands/ship.md": "Ship it\n",
    ".codex/config.toml": [
      'model = "gpt-5"', 'approval_policy = "on-request"', `api_key = "${SECRETS[0]}"`, "",
      "[mcp_servers.docs]", `url = "${SECRETS[1]}"`, `bearer_token = "${SECRETS[2]}"`, "",
      "[hooks.PreToolUse]", `command = "${SECRETS[4]}"`, "", "[profiles.fast]", 'model = "o4"', "",
    ].join("\n"),
    ".codex/hooks.json": JSON.stringify({ hooks: { Stop: [{ command: SECRETS[4] }] } }),
    ".codex/agents/helper.toml": 'name = "helper"\ndescription = "Helps"\n',
    ".gitignore": "CLAUDE.local.md\n",
    // A discovered file under a repo-configured filter: hashing it cannot decide modification.
    ".gitattributes": ".claude/rules/always.md filter=evil\n",
    "node_modules/pkg/CLAUDE.md": "# never listed\n",
  }, { remote: REMOTE });
  // Local-only and changed files.
  write(main, "CLAUDE.local.md", "# Local only\n");
  // Malformed JSON whose parse error would quote a secret.
  write(main, ".claude/settings.local.json", `{"env":{"K": ${SECRETS[0]}}}`);
  write(main, ".claude/rules/always.md", "# Always, edited locally\n");
  write(main, "packages/web/CLAUDE.md", "# Nested Claude, edited\n");
  write(main, ".claude/skills/draft/SKILL.md", "---\nname: draft\n---\n");
  write(main, ".claude/rules/huge.md", `# Huge\n${"x".repeat(INVENTORY_LIMITS.maxFileBytes + 10)}`);
  // Symlinks: an instruction file pointing outside, and a skills folder linked from elsewhere.
  fs.symlinkSync(path.join(tmp, "outside.md"), path.join(main, "packages/api/CLAUDE.md"));
  fs.mkdirSync(path.join(tmp, "shared-skill"));
  fs.writeFileSync(path.join(tmp, "shared-skill", "SKILL.md"), "---\nname: shared\n---\n");
  fs.symlinkSync(path.join(tmp, "shared-skill"), path.join(main, ".claude/skills/shared"));
  fs.mkdirSync(path.join(main, ".claude/skills/linked-file"));
  fs.symlinkSync(path.join(tmp, "shared-skill", "SKILL.md"), path.join(main, ".claude/skills/linked-file/SKILL.md"));
  fs.symlinkSync(tmp, path.join(main, "linked-dir"));
  // A nested checkout is someone else's repo.
  makeRepo("main-checkout/vendored", { "CLAUDE.md": "# vendored\n" });
  git(main, "checkout", "-q", "-b", "feature/inspect");

  // A linked worktree and a second clone with different files: neither may be read.
  git(main, "worktree", "add", "-q", path.join(tmp, "linked"), "-b", "other");
  write(path.join(tmp, "linked"), "CLAUDE.md", "# worktree only\n");
  write(path.join(tmp, "linked"), "WORKTREE_ONLY/AGENTS.md", "# worktree only\n");
  const clone = makeRepo("second-clone", { "CLONE_ONLY/AGENTS.md": "# clone\n" }, { remote: REMOTE });

  const snapshot = (root) => {
    const out = {};
    const walk = (dir) => {
      for (const dirent of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, dirent.name);
        const stat = fs.lstatSync(full);
        out[full] = `${stat.size}:${stat.mtimeMs}`;
        if (dirent.isDirectory() && !dirent.isSymbolicLink()) walk(full);
      }
    };
    walk(root);
    return out;
  };
  // Set last, so the fixture's own Git commands above cannot trip them.
  // Repo-configured processes that must never run: a clean filter, an fsmonitor, and hooks.
  const run = `sh -c 'touch ${marker}'`;
  git(main, "config", "filter.evil.clean", run);
  git(main, "config", "filter.evil.smudge", run);
  git(main, "config", "core.fsmonitor", run);
  write(main, ".git/hooks/post-index-change", `#!/bin/sh\ntouch ${marker}\n`);
  fs.chmodSync(path.join(main, ".git/hooks/post-index-change"), 0o755);
  // Files the preview must refuse even though their names match a native pattern.
  write(main, ".git/CLAUDE.md", "# inside git\n");
  write(main, "node_modules/pkg/CLAUDE.md", "# dependency\n");
  const before = snapshot(main);

  const registry = registryWith(MAIN_ID, [
    { path: path.join(tmp, "linked"), kind: "worktree" },
    { path: main, kind: "primary" },
    { path: clone, kind: "clone" },
  ]);
  const inventory = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime });
  const json = JSON.stringify(inventory);
  const byPath = (rel, harness) => inventory.entries.find((entry) => entry.path === rel && (!harness || entry.harness === harness));

  assert.equal(inventory.status, "ok");
  assert.equal(inventory.checkout.path, main, "the primary checkout, not the worktree or clone");
  assert.deepEqual(inventory.checkout.head, { kind: "branch", name: "feature/inspect" }, "a non-default branch is labeled");
  for (const foreign of ["WORKTREE_ONLY", "CLONE_ONLY", "vendored", "node_modules", "worktree only", "outside.md"]) {
    assert.equal(json.includes(foreign), false, `${foreign} never appears`);
  }

  // Providers: listed without enablement; Gemini is unsupported, not empty.
  assert.deepEqual(inventory.providers.map((p) => [p.id, p.supported, p.enabled]), [["claude", true, false], ["codex", true, false], ["gemini", false, false]]);

  // Instructions.
  assert.equal(byPath("CLAUDE.md").loading, "root-level");
  assert.equal(byPath("CLAUDE.md").git.status, "tracked");
  assert.equal(byPath("CLAUDE.md").git.modified, false);
  assert.ok(byPath("CLAUDE.md").tokens > 0);
  assert.equal(byPath("AGENTS.md", "codex").loading, "root-level", "AGENTS.md is a root-level Codex entry");
  assert.equal(byPath("AGENTS.md", "claude").loading, "potentially-conditional", "and a conditional Claude entry");
  assert.equal(byPath("packages/api/AGENTS.override.md", "claude"), undefined, "Claude has no override file");
  assert.equal(byPath("packages/api/AGENTS.md", "codex").loading, "potentially-conditional");
  assert.equal(byPath("packages/api/AGENTS.override.md").override, true);
  assert.equal(byPath("packages/web/CLAUDE.md").git.modified, true, "a tracked local modification is labeled");
  assert.equal(byPath("CLAUDE.local.md").git.status, "ignored");
  assert.equal(byPath(".claude/rules/always.md").loading, "root-level");
  assert.equal(byPath(".claude/rules/always.md").git.status, "tracked");
  assert.equal(byPath(".claude/rules/always.md").git.modified, undefined, "a filtered file's modification is omitted, not guessed");
  assert.equal(byPath(".claude/rules/scoped.md").loading, "potentially-conditional");
  assert.match(byPath(".claude/rules/huge.md").diagnostic, /Larger than/);
  assert.equal(byPath(".claude/rules/huge.md").tokens, null);
  const linked = byPath("packages/api/CLAUDE.md");
  assert.equal(linked.symlink, true, "a symlinked source is listed as a reference");
  assert.equal(linked.tokens, null);
  assert.equal(byPath("linked-dir"), undefined, "a symlinked folder is not traversed");

  // Skills: native, nested, legacy, untracked, and symlinked.
  assert.equal(byPath(".claude/skills/review/SKILL.md").description, "Reviews a diff.");
  assert.equal(byPath(".claude/skills/review/SKILL.md").loading, "on-demand");
  assert.equal(byPath("packages/web/.claude/skills/nested-skill/SKILL.md").name, "nested-skill");
  assert.equal(byPath(".agents/skills/codex-skill/SKILL.md").harness, "codex");
  assert.equal(byPath(".codex/skills/legacy-skill/SKILL.md").legacy, true);
  assert.equal(byPath(".codex/skills/legacy-skill/SKILL.md").loading, "unknown");
  assert.equal(byPath(".claude/skills/draft/SKILL.md").git.status, "untracked");
  assert.equal(byPath(".claude/skills/shared").symlink, true);
  assert.equal(byPath(".claude/skills/linked-file/SKILL.md").symlink, true, "a symlinked SKILL.md is a reference too");
  assert.equal(json.includes("name: shared"), false, "a symlink target is not read");

  // Other configuration: section labels only.
  const settings = byPath(".claude/settings.json");
  assert.ok(settings.sections.includes("Permissions: 1 allow, 1 deny rules"));
  assert.ok(settings.sections.includes("Default permission mode: acceptEdits"));
  assert.ok(settings.sections.includes("Hooks: PreToolUse, 1 other event"));
  assert.ok(settings.sections.includes("Environment variables: 1"));
  assert.match(byPath(".claude/settings.local.json").diagnostic, /^Could not parse JSON\.$/);
  assert.equal(byPath(".mcp.json").sections[0], "MCP servers: remote (http), local (stdio), 1 unnamed server");
  assert.equal(byPath(".claude/agents/reviewer.md").name, "reviewer");
  assert.equal(byPath(".claude/commands/ship.md").area, "config");
  const codexConfig = byPath(".codex/config.toml").sections;
  assert.ok(codexConfig.includes("Declares: Model, Approval policy"));
  assert.ok(codexConfig.includes("MCP servers: docs"));
  assert.ok(codexConfig.includes("Hooks: PreToolUse"));
  assert.ok(codexConfig.includes("Profiles: fast"));
  assert.deepEqual(byPath(".codex/hooks.json").sections, ["Hooks: Stop"]);
  assert.equal(byPath(".codex/agents/helper.toml").name, "helper");
  for (const secret of SECRETS) assert.equal(json.includes(secret.slice(0, 8)), false, `inventory never carries ${secret}`);

  // Previews: text bodies, summaries for config, and refusals.
  const preview = (id) => loadRepositoryAgentConfigSource({ registry, repositoryId: MAIN_ID, id, runtime });
  const body = await preview("claude:CLAUDE.md");
  assert.equal(body.ok, true);
  assert.equal(body.content, "# Root instructions\n@AGENTS.md\n", "imports stay as source text");
  assert.equal(body.git.status, "tracked");
  const config = await preview("claude:.claude/settings.json");
  assert.equal(config.content, undefined, "structured config is never returned raw");
  assert.ok(config.sections.length > 0);
  for (const id of ["codex:.codex/config.toml", "claude:.mcp.json", "claude:.claude/settings.local.json"]) {
    const summary = JSON.stringify(await preview(id));
    for (const secret of SECRETS) assert.equal(summary.includes(secret.slice(0, 8)), false, `${id} preview never carries ${secret}`);
  }
  for (const id of [
    "claude:../outside.md", "claude:/etc/passwd", "claude:packages/api/CLAUDE.md", "claude:linked-dir/outside.md",
    "claude:vendored/CLAUDE.md", "claude:README.md", "gemini:GEMINI.md", "claude:", "nope",
    "claude:node_modules/pkg/CLAUDE.md", "claude:Node_Modules/pkg/CLAUDE.md", "claude:.git/CLAUDE.md",
    "claude:.claude/skills/linked-file/SKILL.md",
  ]) {
    const refused = await preview(id);
    assert.equal(refused.ok, false, `${id} is refused`);
  }

  // Nothing ran, and nothing in the checkout or its Git directory changed.
  assert.equal(fs.existsSync(marker), false, "no repo-configured process ran");
  assert.deepEqual(snapshot(main), before, "the checkout and its Git metadata are untouched");

  // ------------------------------------------------------------------ checkout selection
  git(main, "checkout", "-q", "--detach");
  const detached = selectPrimaryCheckout(registry, MAIN_ID);
  assert.equal(detached.head.kind, "detached");
  assert.match(detached.head.sha, /^[0-9a-f]{12}$/);

  const cases = [
    ["pathless primary", [{ path: null, kind: "primary" }, { path: clone, kind: "clone" }], "no-path"],
    ["absent primary", [{ path: path.join(tmp, "gone"), kind: "primary" }, { path: clone, kind: "clone" }], "missing"],
    ["two primaries", [{ path: main, kind: "primary" }, { path: clone, kind: "primary" }], "ambiguous"],
    ["two families, no primary", [{ path: main, kind: "clone" }, { path: clone, kind: "clone" }], "ambiguous"],
  ];
  for (const [label, roots, reason] of cases) {
    const reg = registryWith(MAIN_ID, roots);
    // registerLocalRoot promotes the first "clone" to primary, so the stored kinds are reset to
    // exactly the ones this case names.
    reg.repositories[MAIN_ID].localRoots.forEach((root, index) => { root.kind = roots[index].kind; });
    const result = selectPrimaryCheckout(reg, MAIN_ID);
    assert.equal(result.ok, false, label);
    assert.equal(result.reason, reason, label);
    const unavailable = await loadRepositoryAgentConfig({ registry: reg, repositoryId: MAIN_ID, runtime });
    assert.equal(unavailable.status, "checkout-unavailable", label);
    assert.equal(unavailable.entries, undefined, `${label}: no files from another checkout`);
  }
  // One family without a primary: the linked worktree resolves to its main checkout.
  const family = registryWith(MAIN_ID, [{ path: path.join(tmp, "linked"), kind: "worktree" }]);
  assert.equal(selectPrimaryCheckout(family, MAIN_ID).path, main);
  // A recorded path now holding another repo is not this repo's checkout.
  const other = makeRepo("other-repo", {}, { remote: "https://github.com/acme/another.git" });
  const moved = registryWith(MAIN_ID, [{ path: other, kind: "primary" }]);
  assert.equal(selectPrimaryCheckout(moved, MAIN_ID).reason, "moved");

  // ------------------------------------------------------------------ limits and failures
  const limited = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxFiles: 3 } });
  assert.equal(limited.entries.length, 3);
  assert.ok(limited.truncated.includes("files"), "a truncated scan says so");
  // A file cut short by the scan's byte budget marks the scan partial, even as the last file read.
  const budget = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxTotalBytes: 40 } });
  assert.ok(budget.truncated.includes("bytes"));
  assert.ok(budget.entries.some((entry) => /size budget/.test(entry.diagnostic || "")));
  assert.equal(budget.entries.some((entry) => /Larger than/.test(entry.diagnostic || "") && entry.size < INVENTORY_LIMITS.maxFileBytes), false);
  const shallow = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxDepth: 1 } });
  assert.ok(shallow.truncated.includes("depth"));
  const failing = {
    projectInventoryProviders: () => runtime.projectInventoryProviders().map((item) => (item.provider.id === "codex"
      ? { ...item, inventory: { classify: () => { throw new Error("boom"); }, describe: () => ({}) } }
      : item)),
  };
  const isolated = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime: failing });
  assert.match(isolated.providers.find((p) => p.id === "codex").error, /boom/);
  assert.ok(isolated.entries.some((entry) => entry.harness === "claude"), "one provider's failure leaves the others");
  assert.equal(isolated.entries.some((entry) => entry.harness === "codex"), false);
  const empty = makeRepo("empty-repo", { "README.md": "# nothing\n" }, { remote: "https://github.com/acme/empty.git" });
  const emptyInventory = await loadRepositoryAgentConfig({
    registry: registryWith(normalizeGitRemote("https://github.com/acme/empty.git"), [{ path: empty, kind: "primary" }]),
    repositoryId: normalizeGitRemote("https://github.com/acme/empty.git"),
    runtime,
  });
  assert.equal(emptyInventory.status, "ok");
  assert.deepEqual(emptyInventory.entries, []);
  assert.deepEqual(emptyInventory.truncated, [], "an empty scan is not a truncated one");

  // Symlinked native folders are references, not an empty scan, and count toward the file limit.
  const sharedClaude = path.join(tmp, "shared-claude");
  write(sharedClaude, "settings.json", "{}");
  write(path.join(tmp, "shared-agent-skills"), "s/SKILL.md", "---\nname: s\n---\n");
  const LINKED_REMOTE = "https://github.com/acme/linked-config.git";
  const linkedConfig = makeRepo("linked-config", { "README.md": "# r\n" }, { remote: LINKED_REMOTE });
  fs.symlinkSync(sharedClaude, path.join(linkedConfig, ".claude"));
  fs.mkdirSync(path.join(linkedConfig, ".agents"));
  fs.symlinkSync(path.join(tmp, "shared-agent-skills"), path.join(linkedConfig, ".agents", "skills"));
  const linkedRegistry = registryWith(normalizeGitRemote(LINKED_REMOTE), [{ path: linkedConfig, kind: "primary" }]);
  const linkedInventory = await loadRepositoryAgentConfig({ registry: linkedRegistry, repositoryId: normalizeGitRemote(LINKED_REMOTE), runtime });
  const linkedEntries = Object.fromEntries(linkedInventory.entries.map((entry) => [`${entry.harness}:${entry.path}`, entry]));
  assert.equal(linkedEntries["claude:.claude"].kind, "linked-folder");
  assert.equal(linkedEntries["claude:.claude"].symlink, true);
  assert.equal(linkedEntries["codex:.agents/skills"].area, "skills");
  assert.equal(JSON.stringify(linkedInventory).includes("name: s"), false, "files behind a linked folder are not read");
  const linkedCapped = await loadRepositoryAgentConfig({
    registry: linkedRegistry, repositoryId: normalizeGitRemote(LINKED_REMOTE), runtime, limits: { ...INVENTORY_LIMITS, maxFiles: 1 },
  });
  assert.equal(linkedCapped.entries.length, 1);
  assert.ok(linkedCapped.truncated.includes("files"), "symlink references count toward the file limit");

  // A reftable repo's HEAD file is a placeholder; the branch comes from Git.
  const REFTABLE_REMOTE = "https://github.com/acme/reftable.git";
  const reftable = path.join(tmp, "reftable");
  fs.mkdirSync(reftable);
  git(reftable, "init", "-q", "--ref-format=reftable", "-b", "trunk");
  git(reftable, "remote", "add", "origin", REFTABLE_REMOTE);
  git(reftable, "commit", "-q", "--allow-empty", "-m", "init");
  assert.equal(fs.readFileSync(path.join(reftable, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/.invalid");
  const reftableHead = selectPrimaryCheckout(registryWith(normalizeGitRemote(REFTABLE_REMOTE), [{ path: reftable, kind: "primary" }]), normalizeGitRemote(REFTABLE_REMOTE));
  assert.deepEqual(reftableHead.head, { kind: "branch", name: "trunk" });

  // Codex config spelled with inline tables and dotted keys summarizes the same way, without values.
  const inline = (text) => describeCodexProjectFile({ kind: "config" }, text).sections;
  assert.deepEqual(inline('[hooks]\nPreToolUse = [{ command = "x" }]\n'), ["Hooks: PreToolUse"]);
  assert.deepEqual(inline('mcp_servers.inline.command = "x"\n'), ["MCP servers: inline"]);
  assert.deepEqual(inline(`mcp_servers = { other = { url = "${SECRETS[1]}" }, "quoted-name" = { command = "x" } }\n`), ["MCP servers: other, quoted-name"]);
  assert.deepEqual(inline('[mcp_servers]\ndocs = { url = "x" }\n'), ["MCP servers: docs"]);
  // Text inside a multi-line value is never read as a key or header.
  const multiline = describeCodexProjectFile({ kind: "config" }, [
    'notes = """', "mcp_servers.ghp_SECRETTOKEN123 = 1", "[Note] be nice", '"""',
    "tags = [", '  "a",', "  [1, 2],", "]", 'model = "gpt-5"', "",
  ].join("\n"));
  assert.deepEqual(multiline, { sections: ["Declares: Model"] }, "no diagnostic, no key from inside a value");
  const agent = describeCodexProjectFile({ kind: "agent" }, 'name = "a"\ndeveloper_instructions = \'\'\'\nmodel = "not real"\n[Note]\n\'\'\'\n');
  assert.deepEqual(agent, { name: "a", sections: ["Declares developer instructions"] });

  // ------------------------------------------------------------------ provider contract
  assert.throws(() => validateCapabilityAdapters([], { projectInventory: { classify() {} } }), /projectInventory\.describe/);
  validateCapabilityAdapters([], { projectInventory: { classify() {}, describe() {} } });
  for (const provider of listHarnessProviders()) {
    validateCapabilityAdapters(provider.manifest.capabilities, provider.adapters);
  }

  console.log("repository agent config checks passed");
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}
