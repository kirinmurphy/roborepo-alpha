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
import { defaultRunGit } from "../../modules/repositories/git-exec.mjs";

const tmp = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "repository-agent-config-")));
const marker = path.join(tmp, "process-ran");

// Git hooks export these; inherited, they would point the fixture's commands at the outer repo.
const fixtureGitEnv = { ...process.env };
for (const key of ["GIT_DIR", "GIT_WORK_TREE", "GIT_INDEX_FILE"]) delete fixtureGitEnv[key];

function git(cwd, ...args) {
  const result = spawnSync("git", ["-c", "user.name=t", "-c", "user.email=t@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd, encoding: "utf8", env: fixtureGitEnv });
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
    "packages/web/.claude/skills/nested-skill/SKILL.md": "---\nname: nested-skill\ndescription: Only for the web package.\n---\n",
    ".agents/skills/codex-skill/SKILL.md": "---\nname: codex-skill\ndescription: A Codex skill.\n---\n",
    ".codex/skills/legacy-skill/SKILL.md": "---\nname: legacy-skill\ndescription: Kept in the older folder.\n---\n",
    // The same skill name in both Codex folders: listed twice, counted once at startup.
    ".codex/skills/codex-skill/SKILL.md": "---\nname: codex-skill\ndescription: An older copy with a longer description than the current one.\n---\n",
    // Two current skills that share a name both count: only a name in both folders is dropped.
    ".agents/skills/twin-a/SKILL.md": "---\nname: twin\ndescription: First of two.\n---\n",
    ".agents/skills/twin-b/SKILL.md": "---\nname: twin\ndescription: Second of two.\n---\n",
    // Nested skill folders apply to work in that package, not at startup.
    "packages/web/.codex/skills/nested-older/SKILL.md": "---\nname: nested-older\ndescription: Only for the web package.\n---\n",
    "packages/web/.agents/skills/nested-current/SKILL.md": "---\nname: nested-current\ndescription: Only for the web package.\n---\n",
    "local/skills/codex-linked/SKILL.md": "---\nname: codex-linked\ndescription: Linked into the older folder.\n---\n",
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
    ".claude/agents/reviewer.md": "---\nname: reviewer\ndescription: Reviews.\n---\nPrompt\n![pixel](https://evil.invalid/pixel.png)\n",
    // A skill kept elsewhere in the repo and linked into both harnesses' folders.
    "local/skills/inrepo/SKILL.md": "---\nname: inrepo\ndescription: Lives in the repo.\n---\n# In repo\nBody\n",
    "local/skills/inrepo/references/guide.md": "# Guide\nRead me.\n",
    // Rendered output marked linguist-generated: flagged, left off the page, and never counted, even
    // where an ordinary file in the same place would load at startup.
    "generated/claude/CLAUDE.md": "# Generated\n",
    ".claude/rules/rendered.md": "# Rendered rule\n",
    ".claude/skills/rendered/SKILL.md": "---\nname: rendered\ndescription: Rendered elsewhere.\n---\n",
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
    ".gitattributes": ".claude/rules/always.md filter=evil\n.claude/agents/filtered.md filter=evil\ngenerated/** linguist-generated=true\n.claude/rules/rendered.md linguist-generated=true\n.claude/skills/rendered/** linguist-generated=true\n",
    // Filtered and unchanged: matching the index blob proves nothing when a clean filter applies.
    ".claude/agents/filtered.md": "---\nname: filtered\n---\nUnchanged\n",
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
  fs.symlinkSync("../../local/skills/inrepo", path.join(main, ".claude/skills/inrepo"));
  fs.mkdirSync(path.join(main, ".agents/skills"), { recursive: true });
  fs.symlinkSync("../../local/skills/inrepo", path.join(main, ".agents/skills/inrepo"));
  // The shape RoboRepo's skill linking makes: a .codex/skills folder linked to a skill in the repo.
  fs.symlinkSync("../../local/skills/codex-linked", path.join(main, ".codex/skills/codex-linked"));
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
  assert.equal(selectPrimaryCheckout(registry, MAIN_ID).path, main, "the primary checkout, not the worktree or clone");
  assert.equal(json.includes(tmp), false, "no absolute path reaches the response");
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
  assert.equal(byPath(".claude/agents/filtered.md").git.modified, undefined, "an unchanged filtered file is not called unmodified either");
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
  assert.equal(byPath(".codex/skills/legacy-skill/SKILL.md").loading, "on-demand", "Codex reads the older folder too");
  assert.equal(byPath(".claude/skills/draft/SKILL.md").git.status, "untracked");
  assert.equal(byPath(".claude/skills/shared").symlink, true);
  assert.equal(byPath(".claude/skills/linked-file/SKILL.md").symlink, true, "a symlinked SKILL.md is a reference too");
  assert.equal(json.includes("name: shared"), false, "a symlink target is not read");
  // A symlink resolving inside the checkout is read through its target, once for both harnesses.
  const inRepo = byPath(".claude/skills/inrepo");
  assert.equal(inRepo.linkTarget, "local/skills/inrepo/SKILL.md");
  assert.equal(inRepo.description, "Lives in the repo.");
  assert.ok(inRepo.tokens > 0 && inRepo.discoveryTokens > 0);
  assert.equal(byPath(".agents/skills/inrepo").contentHash, inRepo.contentHash, "copies of one skill share a content hash");
  assert.equal(byPath(".claude/skills/shared").linkTarget, undefined, "a link out of the checkout has no target");

  // Generated files are flagged and left out of the startup totals.
  assert.equal(byPath("generated/claude/CLAUDE.md").generated, true);
  assert.equal(byPath(".claude/rules/rendered.md").generated, true);
  assert.equal(byPath(".claude/rules/rendered.md").loading, "root-level", "generated, yet where a rule loads at startup");
  assert.equal(byPath("CLAUDE.md").generated, undefined);
  const startup = Object.fromEntries(inventory.startup.map((item) => [item.harness, item]));
  assert.deepEqual(Object.keys(startup), ["claude", "codex"], "one total per supported harness");
  assert.deepEqual(startup.claude.files.sort(), [".claude/rules/always.md", "CLAUDE.local.md", "CLAUDE.md"].sort(),
    "root-level instructions count; scoped rules, nested and generated files do not");
  // Skill discovery counts root skills only: not a nested package's skill, and not a generated one.
  const claudeSkills = inventory.entries.filter((entry) => entry.harness === "claude" && entry.kind === "skill");
  const nestedSkill = byPath("packages/web/.claude/skills/nested-skill/SKILL.md");
  const generatedSkill = byPath(".claude/skills/rendered/SKILL.md");
  assert.ok(nestedSkill.discoveryTokens > 0 && generatedSkill.discoveryTokens > 0 && generatedSkill.generated);
  const rootSkillTokens = claudeSkills
    .filter((entry) => entry !== nestedSkill && entry !== generatedSkill && entry.discoveryTokens != null)
    .reduce((sum, entry) => sum + entry.discoveryTokens, 0);
  assert.ok(rootSkillTokens > 0, "skill names and descriptions count at startup");
  assert.equal(startup.claude.breakdown.skillDiscovery, rootSkillTokens, "nested and generated skills add nothing");
  assert.equal(startup.claude.tokens, startup.claude.breakdown.instructions + startup.claude.breakdown.skillDiscovery + startup.claude.breakdown.commandDiscovery);
  assert.deepEqual(startup.codex.files, ["AGENTS.md"]);
  // Codex counts root skills from .agents/skills and .codex/skills; a name in both counts once,
  // from .agents/skills.
  const codexSkill = (rel) => {
    const entry = byPath(rel);
    assert.ok(entry?.discoveryTokens > 0, `${rel} is measured`);
    return entry.discoveryTokens;
  };
  assert.notEqual(codexSkill(".codex/skills/codex-skill/SKILL.md"), codexSkill(".agents/skills/codex-skill/SKILL.md"));
  codexSkill("packages/web/.codex/skills/nested-older/SKILL.md");
  codexSkill("packages/web/.agents/skills/nested-current/SKILL.md");
  assert.equal(startup.codex.breakdown.skillDiscovery,
    codexSkill(".agents/skills/codex-skill/SKILL.md") + codexSkill(".agents/skills/inrepo")
      + codexSkill(".agents/skills/twin-a/SKILL.md") + codexSkill(".agents/skills/twin-b/SKILL.md")
      + codexSkill(".codex/skills/legacy-skill/SKILL.md") + codexSkill(".codex/skills/codex-linked"),
    "root skills in both folders count, a name in both only once, and nested skills not at all");

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
  for (const id of ["codex:.codex/config.toml", "claude:.mcp.json", "claude:.claude/settings.local.json", "claude:.claude/settings.json", "codex:.codex/hooks.json"]) {
    const summary = JSON.stringify(await preview(id));
    for (const secret of SECRETS) assert.equal(summary.includes(secret.slice(0, 8)), false, `${id} preview never carries ${secret}`);
  }
  // Config previews are a readable list of keys with safe values.
  assert.match(config.html, /config-tree/);
  assert.ok(config.html.includes("Bash(ls:*)") && config.html.includes("acceptEdits"), "permission rules and modes are shown");
  assert.ok((await preview("codex:.codex/config.toml")).html.includes("on-request"));
  // Markdown renders, without images a repo could use to fetch a URL.
  const agentPreview = await preview("claude:.claude/agents/reviewer.md");
  assert.ok(agentPreview.html.includes("pixel") && !agentPreview.html.includes("<img") && !agentPreview.html.includes("evil.invalid"));
  // A skill opens in the global page's skill view, with its bundled files, through an in-repo link.
  const skillPreview = await preview("claude:.claude/skills/inrepo");
  assert.equal(skillPreview.ok, true);
  assert.equal(skillPreview.linkTarget, "local/skills/inrepo/SKILL.md");
  assert.match(skillPreview.html, /skill-source-view/);
  assert.ok(skillPreview.html.includes("references/guide.md") && skillPreview.html.includes("Read me."));
  // Previews name files by their place in the repo, never by an absolute path.
  for (const id of ["claude:.claude/skills/inrepo", "claude:.claude/settings.json", "claude:CLAUDE.md"]) {
    assert.equal(JSON.stringify(await preview(id)).includes(tmp), false, `${id} preview carries no absolute path`);
  }
  assert.ok(skillPreview.discoveryTokens > 0);
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
  // Previews: an oversized config says so, and the text limit counts bytes, not characters.
  write(main, ".claude/agents/big.md", "é".repeat(INVENTORY_LIMITS.previewBytes));
  const wide = await loadRepositoryAgentConfigSource({ registry, repositoryId: MAIN_ID, id: "claude:.claude/agents/big.md", runtime });
  assert.equal(wide.truncated, true);
  assert.ok(Buffer.byteLength(wide.content) <= INVENTORY_LIMITS.previewBytes + 3, "the preview is cut at the byte limit");
  write(main, ".claude/settings.json", JSON.stringify({ permissions: { allow: ["x"] }, pad: "x".repeat(INVENTORY_LIMITS.maxFileBytes) }));
  const bigConfig = await loadRepositoryAgentConfigSource({ registry, repositoryId: MAIN_ID, id: "claude:.claude/settings.json", runtime });
  assert.match(bigConfig.diagnostic, /Larger than/);

  // A file cut short by the scan's byte budget marks the scan partial, even as the last file read.
  const budget = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxTotalBytes: 40 } });
  assert.ok(budget.truncated.includes("bytes"));
  assert.ok(budget.entries.some((entry) => /size budget/.test(entry.diagnostic || "")));
  assert.equal(budget.entries.some((entry) => /Larger than/.test(entry.diagnostic || "") && entry.size < INVENTORY_LIMITS.maxFileBytes), false);
  const shallow = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxDepth: 1 } });
  assert.ok(shallow.truncated.includes("depth"));
  const fewEntries = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, limits: { ...INVENTORY_LIMITS, maxEntriesVisited: 3 } });
  assert.ok(fewEntries.truncated.includes("entries"), "the entry budget stops the walk and says so");
  assert.ok(fewEntries.entries.length <= 3);

  // When the attribute query fails, a changed tracked file's modification is unknown, not "modified".
  const noAttributes = (cwd, args, options) => (args[0] === "check-attr"
    ? Promise.resolve({ ok: false, stdout: "", code: 1, error: "check-attr failed" })
    : defaultRunGit(cwd, args, options));
  const unknownAttributes = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime, runGit: noAttributes });
  const unknownByPath = (rel) => unknownAttributes.entries.find((entry) => entry.path === rel);
  assert.equal(unknownByPath("packages/web/CLAUDE.md").git.modified, undefined, "unknown attributes leave a changed file unlabeled");
  assert.equal(unknownByPath("CLAUDE.md").git.modified, undefined, "unknown attributes leave an unchanged file unlabeled too");
  const unknownPreview = await loadRepositoryAgentConfigSource({ registry, repositoryId: MAIN_ID, id: "claude:packages/web/CLAUDE.md", runtime, runGit: noAttributes });
  assert.equal(unknownPreview.git.modified, undefined);

  // In a partial clone, check-attr could fetch a missing .gitattributes blob on Git that ignores
  // GIT_NO_LAZY_FETCH, so it never runs there, and a changed tracked file's modification is unknown.
  const PARTIAL_REMOTE = "https://github.com/acme/partial.git";
  const partialRepo = makeRepo("partial-clone", { "CLAUDE.md": "# Partial\n" }, { remote: PARTIAL_REMOTE });
  write(partialRepo, "CLAUDE.md", "# Partial, edited\n");
  git(partialRepo, "config", "remote.origin.promisor", "true");
  git(partialRepo, "config", "extensions.partialclone", "origin");
  const gitCalls = [];
  const countingGit = (cwd, args, options) => {
    gitCalls.push(args[0]);
    return defaultRunGit(cwd, args, options);
  };
  const partialInventory = await loadRepositoryAgentConfig({
    registry: registryWith(normalizeGitRemote(PARTIAL_REMOTE), [{ path: partialRepo, kind: "primary" }]),
    repositoryId: normalizeGitRemote(PARTIAL_REMOTE),
    runtime,
    runGit: countingGit,
  });
  const partialClaude = partialInventory.entries.find((entry) => entry.path === "CLAUDE.md" && entry.harness === "claude");
  assert.ok(gitCalls.includes("ls-files"), "the partial clone was still classified");
  assert.equal(gitCalls.includes("check-attr"), false, "check-attr never runs in a partial clone");
  assert.equal(partialClaude.git.status, "tracked");
  assert.equal(partialClaude.git.modified, undefined, "a changed tracked file in a partial clone has no modification label");

  // A folder the walk cannot open makes the result partial instead of looking empty.
  const locked = path.join(main, "locked");
  write(main, "locked/CLAUDE.md", "# locked\n");
  fs.chmodSync(locked, 0o000);
  try {
    const partial = await loadRepositoryAgentConfig({ registry, repositoryId: MAIN_ID, runtime });
    assert.equal(partial.status, "ok");
    assert.deepEqual(partial.unreadableFolders, ["locked"], "an unreadable folder is named");
    assert.equal(partial.unreadableCount, 1);
  } finally {
    fs.chmodSync(locked, 0o755);
    fs.rmSync(locked, { recursive: true, force: true });
  }
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
  // Linked subfolders inside a real .claude or .codex folder are references too.
  const LINKED_SUB_REMOTE = "https://github.com/acme/linked-subfolders.git";
  const linkedSub = makeRepo("linked-subfolders", { "README.md": "# r\n" }, { remote: LINKED_SUB_REMOTE });
  write(path.join(tmp, "shared-rules"), "always.md", "# shared rule\n");
  for (const folder of [".claude/rules", ".claude/agents", ".claude/commands", ".codex/agents"]) {
    fs.mkdirSync(path.join(linkedSub, path.dirname(folder)), { recursive: true });
    fs.symlinkSync(path.join(tmp, "shared-rules"), path.join(linkedSub, folder));
  }
  const linkedSubInventory = await loadRepositoryAgentConfig({
    registry: registryWith(normalizeGitRemote(LINKED_SUB_REMOTE), [{ path: linkedSub, kind: "primary" }]),
    repositoryId: normalizeGitRemote(LINKED_SUB_REMOTE),
    runtime,
  });
  assert.deepEqual(
    linkedSubInventory.entries.map((entry) => `${entry.harness}:${entry.path}:${entry.area}:${entry.kind}`).sort(),
    [
      "claude:.claude/agents:config:linked-folder", "claude:.claude/commands:config:linked-folder",
      "claude:.claude/rules:instructions:linked-folder", "codex:.codex/agents:config:linked-folder",
    ],
  );
  // A linked subfolder inside a real rules or agents folder is a reference; a linked rule file is a rule.
  const NESTED_REMOTE = "https://github.com/acme/nested-links.git";
  const nested = makeRepo("nested-links", { ".claude/rules/own.md": "# own\n", ".codex/agents/own.toml": 'name = "own"\n' }, { remote: NESTED_REMOTE });
  fs.symlinkSync(path.join(tmp, "shared-rules"), path.join(nested, ".claude/rules/linkedsub"));
  fs.symlinkSync(path.join(tmp, "shared-rules", "always.md"), path.join(nested, ".claude/rules/linked.md"));
  fs.symlinkSync(path.join(tmp, "shared-rules"), path.join(nested, ".codex/agents/linkedsub"));
  const nestedInventory = await loadRepositoryAgentConfig({
    registry: registryWith(normalizeGitRemote(NESTED_REMOTE), [{ path: nested, kind: "primary" }]),
    repositoryId: normalizeGitRemote(NESTED_REMOTE),
    runtime,
  });
  assert.deepEqual(
    nestedInventory.entries.map((entry) => `${entry.harness}:${entry.path}:${entry.kind}:${entry.symlink}`).sort(),
    [
      "claude:.claude/rules/linked.md:rule:true", "claude:.claude/rules/linkedsub:linked-folder:true",
      "claude:.claude/rules/own.md:rule:false", "codex:.codex/agents/linkedsub:linked-folder:true",
      "codex:.codex/agents/own.toml:agent:false",
    ],
  );
  // Inside a harness's own folder, a skill or command named like a build output is still listed,
  // while the same names elsewhere stay skipped.
  const NAMED_REMOTE = "https://github.com/acme/build-named-skills.git";
  const named = makeRepo("build-named-skills", {
    ".claude/skills/build/SKILL.md": "---\nname: build\n---\n",
    ".claude/skills/coverage/SKILL.md": "---\nname: coverage\n---\n",
    ".agents/skills/vendor/SKILL.md": "---\nname: vendor\n---\n",
    ".claude/commands/out/ship.md": "Ship it\n",
    "build/CLAUDE.md": "# generated\n",
    "vendor/lib/AGENTS.md": "# vendored\n",
  }, { remote: NAMED_REMOTE });
  const namedRegistry = registryWith(normalizeGitRemote(NAMED_REMOTE), [{ path: named, kind: "primary" }]);
  const namedInventory = await loadRepositoryAgentConfig({ registry: namedRegistry, repositoryId: normalizeGitRemote(NAMED_REMOTE), runtime });
  assert.deepEqual(namedInventory.entries.map((entry) => entry.path).sort(), [
    ".agents/skills/vendor/SKILL.md", ".claude/commands/out/ship.md",
    ".claude/skills/build/SKILL.md", ".claude/skills/coverage/SKILL.md",
  ]);
  assert.deepEqual(namedInventory.truncated, []);
  const namedPreview = (id) => loadRepositoryAgentConfigSource({ registry: namedRegistry, repositoryId: normalizeGitRemote(NAMED_REMOTE), id, runtime });
  assert.equal((await namedPreview("claude:.claude/skills/build/SKILL.md")).ok, true, "the preview agrees with the walk");
  assert.equal((await namedPreview("claude:build/CLAUDE.md")).ok, false, "a real build folder stays skipped");
  const linkedCapped = await loadRepositoryAgentConfig({
    registry: linkedRegistry, repositoryId: normalizeGitRemote(LINKED_REMOTE), runtime, limits: { ...INVENTORY_LIMITS, maxFiles: 1 },
  });
  assert.equal(linkedCapped.entries.length, 1);
  assert.ok(linkedCapped.truncated.includes("files"), "symlink references count toward the file limit");

  // A reftable repo's HEAD file is a placeholder; the branch comes from Git.
  const REFTABLE_REMOTE = "https://github.com/acme/reftable.git";
  // Git before 2.45 has no reftable; only this case is skipped there.
  const reftable = path.join(tmp, "reftable");
  fs.mkdirSync(reftable);
  const reftableInit = spawnSync("git", ["init", "-q", "--ref-format=reftable", "-b", "trunk"], { cwd: reftable, encoding: "utf8", env: fixtureGitEnv });
  if (reftableInit.status === 0) {
    git(reftable, "remote", "add", "origin", REFTABLE_REMOTE);
    git(reftable, "commit", "-q", "--allow-empty", "-m", "init");
    assert.equal(fs.readFileSync(path.join(reftable, ".git", "HEAD"), "utf8").trim(), "ref: refs/heads/.invalid");
    const reftableHead = selectPrimaryCheckout(registryWith(normalizeGitRemote(REFTABLE_REMOTE), [{ path: reftable, kind: "primary" }]), normalizeGitRemote(REFTABLE_REMOTE));
    assert.deepEqual(reftableHead.head, { kind: "branch", name: "trunk" });
  } else {
    console.log("skipped: reftable HEAD (this Git cannot create a reftable repo)");
  }

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
  // Quoted, literal, and spaced dotted keys parse, so their values stay closed too.
  assert.deepEqual(inline('mcp_servers."my-server".command = "npx"\n'), ["MCP servers: my-server"]);
  assert.deepEqual(inline('"mcp_servers" . docs . command = "x"\n'), ["MCP servers: docs"]);
  assert.deepEqual(inline("'notes' = '''\n[profiles.ghp_LEAKTOKEN]\n'''\n"), []);
  assert.deepEqual(inline('a."b" = """\n[mcp_servers.ghp_LEAK2]\n"""\n'), []);
  assert.deepEqual(inline('mcp_servers = { a = "x\\", LEAKED = 2" }\n'), ["MCP servers: a"], "an escaped quote does not end a string");
  assert.deepEqual(describeCodexProjectFile({ kind: "config" }, 'x = [\n[mcp_servers.foo]\n'), {
    sections: [], diagnostic: "Could not parse TOML: a value is never closed.",
  });
  const badKey = describeCodexProjectFile({ kind: "config" }, 'bad key = """\n[mcp_servers.ghp_LEAK3]\n"""\n');
  assert.deepEqual(badKey, { sections: [], diagnostic: "Could not parse TOML on line 1." }, "a malformed key line still closes its value");
  const innerName = describeCodexProjectFile({ kind: "agent" }, 'developer_instructions = """\nname = "inner-value"\n"""\nname = "real"\n');
  assert.equal(innerName.name, "real", "an agent's name comes from its own key, not text inside another value");
  const quotedEquals = describeCodexProjectFile({ kind: "config" }, '"bad=key" extra = """\n[mcp_servers.ghp_LEAK4]\n"""\n');
  assert.deepEqual(quotedEquals, { sections: [], diagnostic: "Could not parse TOML on line 1." }, "an = inside a quoted key does not hide the value it opens");
  assert.deepEqual(inline('mcp_servers = { docs = { command = """tool"}, ghp_LEAK5 = { command = "ignored""" } }\n'), ["MCP servers: docs"], "a triple-quoted string is one value");
  assert.deepEqual(inline("mcp_servers = { docs = { command = '''a}, ghp_LEAK6 = {''' }, two = {} }\n"), ["MCP servers: docs, two"]);
  assert.deepEqual(inline('mcp_servers = { docs = { args = """x"""""}, two = {} }\n'), ["MCP servers: docs, two"], "quotes before the closing delimiter belong to the string");
  for (const spelling of ["[features]\nmulti_agent = true\n", "features.multi_agent = true\n", "features = { multi_agent = true }\n"]) {
    assert.deepEqual(inline(spelling), ["Also declares: Feature flags"], `section labels for ${JSON.stringify(spelling)}`);
  }

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
