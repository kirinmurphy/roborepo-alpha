#!/usr/bin/env node
// The readable config tree behind the Agents page config popups: the TOML document parser, the
// safe-value policy (names always shown, values that can carry a credential never), and the HTML,
// which must escape everything and contain no hidden value anywhere.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseTomlDocument, UNPARSED } from "../harnesses/toml-document.mjs";
import {
  configTree, renderConfigFileHtml, renderConfigTreeHtml, safeConfigValue,
} from "../cli/config-tree-render.mjs";

// --- TOML parsing -------------------------------------------------------------------------------

{
  const { value, diagnostic } = parseTomlDocument([
    "# leading comment",
    "model = \"gpt-5\" # trailing comment",
    "approval_policy = 'on-request'",
    "count = 1_000",
    "ratio = 3.5e2",
    "hex = 0xFF",
    "neg = -12",
    "enabled = true",
    "off = false",
    "when = 1979-05-27T07:32:00Z",
    "day = 1979-05-27",
    "at = 07:32:00",
    "tui.status_line = [\"model\", \"cwd\"]",
    "\"quoted.key\" = 1",
    "inline = { a = 1, b.c = \"x\" }",
    "multi = [",
    "  1, # one",
    "  2,",
    "]",
    "basic = \"\"\"",
    "line one",
    "line \\",
    "   two\"\"\"",
    "literal = '''",
    "raw \\n text",
    "'''",
    "esc = \"tab\\there \\u00e9\"",
    "",
    "[features]",
    "web_search = true",
    "",
    "[mcp_servers.\"my.server\"]",
    "command = \"npx\"",
    "",
    "[[profiles.list]]",
    "name = \"first\"",
    "[profiles.list.sub]",
    "depth = 1",
    "[[profiles.list]]",
    "name = \"second\"",
  ].join("\n"));
  assert.equal(diagnostic, null);
  assert.equal(value.model, "gpt-5");
  assert.equal(value.approval_policy, "on-request");
  assert.equal(value.count, 1000);
  assert.equal(value.ratio, 350);
  assert.equal(value.hex, 255);
  assert.equal(value.neg, -12);
  assert.equal(value.enabled, true);
  assert.equal(value.off, false);
  assert.equal(value.when, "1979-05-27T07:32:00Z");
  assert.equal(value.day, "1979-05-27");
  assert.equal(value.at, "07:32:00");
  assert.deepEqual(value.tui, { status_line: ["model", "cwd"] });
  assert.equal(value["quoted.key"], 1);
  assert.deepEqual(value.inline, { a: 1, b: { c: "x" } });
  assert.deepEqual(value.multi, [1, 2]);
  assert.equal(value.basic, "line one\nline two");
  assert.equal(value.literal, "raw \\n text\n");
  assert.equal(value.esc, "tab\there \u00e9");
  assert.deepEqual(value.features, { web_search: true });
  assert.deepEqual(value.mcp_servers, { "my.server": { command: "npx" } });
  assert.deepEqual(value.profiles.list, [{ name: "first", sub: { depth: 1 } }, { name: "second" }]);
}

{
  const secret = "sk-not-a-real-token-but-still-content";
  const { value, diagnostic } = parseTomlDocument([
    "ok = 1",
    `broken = ${secret}`,
    "after = \"still read\"",
    "[good]",
    "x = 2",
  ].join("\n"));
  assert.equal(value.broken, UNPARSED, "an unparseable value becomes the sentinel");
  assert.equal(value.after, "still read", "parsing continues after a bad statement");
  assert.deepEqual(value.good, { x: 2 });
  assert.equal(diagnostic, "Could not parse TOML on line 2.");
  assert.ok(!diagnostic.includes("sk-"), "the diagnostic never quotes file content");
}

{
  const { value, diagnostic } = parseTomlDocument("__proto__ = 1\na = [1,\nb = 2\n[t\nc = 3\n[u]\nd = 4\n");
  assert.equal(diagnostic, "Could not parse TOML on line 2 (and 1 more).");
  assert.equal(value.a, UNPARSED);
  assert.equal(value.b, 2, "an unclosed array does not swallow the next statement");
  assert.equal(value.c, undefined, "keys under a broken header are not filed under the previous table");
  assert.deepEqual(value.u, { d: 4 });
  assert.equal(Object.getPrototypeOf(value), Object.prototype, "a __proto__ key is data, not a prototype");
  assert.ok(Object.hasOwn(value, "__proto__"));
}

// --- redaction policy ---------------------------------------------------------------------------

const settings = {
  model: "opus",
  env: { ANTHROPIC_API_KEY: "sk-ant-secret-value-1", DISABLE_TELEMETRY: "1", MAX_TOKENS: 4000 },
  permissions: {
    allow: ["Bash(git status:*)", "Read(~/.zshrc)", "WebFetch(domain:example.com)"],
    deny: [],
    defaultMode: "acceptEdits",
  },
  hooks: {
    PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "~/bin/guard.sh --key=hookcmdvalue", timeout: 30 }] }],
  },
  mcpServers: {
    github: {
      type: "stdio",
      command: "npx-mcp-launch",
      args: ["-y", "mcp-server-arg"],
      env: { GITHUB_PERSONAL_ACCESS_TOKEN: "ghp_mcpenvsecretvalue000000000000" },
    },
    remote: { type: "http", url: "mcp.example.invalid/path", headers: { "X-Api-Key": "headervalue123" } },
  },
  statusLine: { type: "command", command: "statuscmdvalue" },
  apiKeyHelper: "helpervalue",
  oauthToken: "tokenvalue123",
  githubToken: 42,
  homepage: "https://docs.example.invalid/urlvalue",
  note: "x".repeat(201),
  cwd: "/Users/someone/project",
  "<script>alert(1)</script>": "<b>bold</b>",
};

const hiddenValues = [
  "sk-ant-secret-value-1", "~/bin/guard.sh", "hookcmdvalue", "npx-mcp-launch", "mcp-server-arg",
  "ghp_mcpenvsecretvalue", "mcp.example.invalid", "headervalue123", "statuscmdvalue", "helpervalue",
  "tokenvalue123", "urlvalue", "x".repeat(201),
];

{
  const shown = (keyPath, value) => safeConfigValue(keyPath, value).shown;
  assert.equal(shown(["model"], "opus"), true);
  assert.equal(shown(["env", "DISABLE_TELEMETRY"], "1"), false, "env values are hidden");
  assert.equal(shown(["env", "MAX_TOKENS"], 4000), true, "numbers stay visible");
  assert.equal(shown(["permissions", "allow", 0], "Bash(git status:*)"), true, "permission rules are shown");
  assert.equal(shown(["hooks", "PreToolUse", 0, "matcher"], "Bash"), true);
  assert.equal(shown(["hooks", "PreToolUse", 0, "hooks", 0, "type"], "command"), true);
  assert.equal(shown(["hooks", "PreToolUse", 0, "hooks", 0, "command"], "guard.sh"), false);
  assert.equal(shown(["mcpServers", "x", "type"], "stdio"), true);
  assert.equal(shown(["mcp_servers", "x", "transport"], "stdio"), true);
  for (const key of ["command", "args", "url", "env", "headers", "http_headers", "env_http_headers"]) {
    assert.equal(shown(["mcp_servers", "x", key, "k"], "v"), false, `${key} values are hidden`);
  }
  assert.equal(shown(["model_providers", "p", "base_url"], "localhost:1234"), false, "url-named keys are hidden");
  assert.equal(shown(["shell_environment_policy", "set", "PATH"], "/bin"), false);
  assert.equal(shown(["apiKeyHelper"], "x"), false);
  assert.equal(shown(["mySecretThing"], "x"), false, "secret-named keys hide strings");
  assert.equal(shown(["auth", "enabled"], true), true, "booleans under a secret-named key stay visible");
  assert.equal(shown(["anything"], "see http://x"), false, "URL strings are hidden anywhere");
  assert.equal(shown(["permissions", "allow", 0], "Bash(curl https://x.invalid:*)"), false, "URL rules are hidden too");
  assert.equal(shown(["permissions", "allow", 0], "Bash(export TOKEN=abc)"), false, "credential-shaped text is hidden");
  assert.equal(safeConfigValue(["note"], "y".repeat(201)).reason, "long");
  assert.equal(shown(["note"], "y".repeat(200)), true);
  assert.equal(shown(["cwd"], "/tmp/project"), true, "paths are shown");
  assert.equal(safeConfigValue(["x"], UNPARSED).reason, "unparsed");
}

{
  const tree = configTree(settings);
  const node = (...keys) => keys.reduce((current, key) => current.children.find((child) => child.key === key), tree);
  assert.equal(node("env").kind, "object");
  assert.deepEqual(node("env").children.map((child) => child.key), ["ANTHROPIC_API_KEY", "DISABLE_TELEMETRY", "MAX_TOKENS"], "env names are shown");
  assert.equal(node("env", "ANTHROPIC_API_KEY").kind, "hidden");
  const allow = node("permissions", "allow");
  assert.equal(allow.kind, "array");
  assert.equal(allow.count, 3);
  assert.deepEqual(allow.children.map((child) => child.text), settings.permissions.allow);
  assert.deepEqual(node("permissions", "deny"), { kind: "empty", of: "array", key: "deny" });
  const hookGroup = node("hooks", "PreToolUse", "#1");
  assert.equal(hookGroup.kind, "object", "arrays of objects become numbered groups");
  assert.equal(node("hooks", "PreToolUse", "#1", "matcher").text, "Bash");
  assert.equal(node("hooks", "PreToolUse", "#1", "hooks", "#1", "command").kind, "hidden");
  assert.equal(node("hooks", "PreToolUse", "#1", "hooks", "#1", "timeout").text, "30");
  assert.deepEqual(node("mcpServers", "github", "args"), { kind: "hidden", reason: "hidden", count: 2, key: "args" });
  assert.equal(node("mcpServers", "github", "type").text, "stdio");
  assert.equal(node("githubToken").text, "42");
  assert.deepEqual(configTree({}), { kind: "empty", of: "object" });
}

// --- HTML ---------------------------------------------------------------------------------------

{
  const html = renderConfigTreeHtml(settings, { format: "json" });
  assert.match(html, /^<div class="config-tree" data-format="json">/);
  for (const secret of hiddenValues) {
    assert.ok(!html.includes(secret), `hidden value leaked into HTML: ${secret.slice(0, 20)}`);
  }
  assert.ok(!html.includes("<script>"), "keys are escaped");
  assert.ok(html.includes("&lt;script&gt;alert(1)&lt;/script&gt;"));
  assert.ok(html.includes("&lt;b&gt;bold&lt;/b&gt;"), "values are escaped");
  assert.ok(html.includes("Bash(git status:*)"));
  assert.ok(html.includes('<span class="config-tree-key">ANTHROPIC_API_KEY</span>'));
  assert.ok(html.includes('<span class="config-tree-count">3 items</span>'));
  assert.ok(html.includes('<span class="config-tree-hidden">long text, not shown</span>'));
  assert.ok(html.includes('<span class="config-tree-empty">empty</span>'));
}

{
  const toml = [
    "model = \"o3\"",
    "notify = [\"notify-cmd-value\"]",
    "[mcp_servers.docs]",
    "command = \"docs-cmd-value\"",
    "env = { DOCS_TOKEN = \"docs-env-value\" }",
    "broken = @nope-secret-content",
  ].join("\n");
  const html = renderConfigFileHtml(toml, { format: "toml" });
  assert.match(html, /^<p class="config-tree-message">Could not parse TOML on line 6\.<\/p>/);
  for (const secret of ["notify-cmd-value", "docs-cmd-value", "docs-env-value", "nope-secret-content"]) {
    assert.ok(!html.includes(secret), `hidden TOML value leaked into HTML: ${secret}`);
  }
  assert.ok(html.includes('<span class="config-tree-key">DOCS_TOKEN</span>'));
  assert.ok(html.includes('<span class="config-tree-hidden">could not be read</span>'));
  assert.ok(html.includes(">o3<"));

  const badJson = renderConfigFileHtml("{\"env\": {\"K\": \"bad-json-secret\"", { format: "json" });
  assert.equal(badJson, '<p class="config-tree-message">Could not parse this JSON file, so its settings are not shown.</p>');

  const hooksOnly = renderConfigFileHtml(JSON.stringify(settings), { format: "json", pick: (parsed) => parsed.hooks });
  assert.ok(hooksOnly.includes("PreToolUse") && !hooksOnly.includes("permissions"));
}

// --- The global page's settings popups: the response itself carries no hidden value ---------------

{
  // Harness config paths resolve from the home directory at import, so the read runs in a child
  // process whose HOME holds settings files with a secret in every hidden category.
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "config-tree-home-"));
  try {
    fs.mkdirSync(path.join(home, ".claude"));
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(path.join(home, ".claude", "settings.json"), JSON.stringify({
      env: { API_KEY: "home-env-secret" },
      apiKeyHelper: "home-helper-secret",
      hooks: { Stop: [{ hooks: [{ type: "command", command: "home-hook-secret" }] }] },
      permissions: { defaultMode: "acceptEdits" },
    }));
    fs.writeFileSync(path.join(home, ".codex", "config.toml"), [
      "model = \"o3\"", "[mcp_servers.docs]", "url = \"https://home-url-secret.invalid\"",
      "env = { TOKEN = \"home-toml-secret\" }",
    ].join("\n"));
    const configModule = new URL("../cli/config.mjs", import.meta.url).href;
    const script = `
      const { loadConfigSource } = await import(${JSON.stringify(configModule)});
      const out = ["claude-settings", "codex-settings"].map((id) => loadConfigSource({ kind: "config-file", id }));
      process.stdout.write(JSON.stringify(out));
    `;
    const stateRoot = path.join(home, ".roborepo");
    const run = spawnSync(process.execPath, ["--input-type=module", "-e", script], {
      env: { ...process.env, HOME: home, ROBOREPO_STATE_ROOT: stateRoot }, encoding: "utf8",
    });
    assert.equal(run.status, 0, run.stderr);
    const [claude, codex] = JSON.parse(run.stdout);
    assert.ok(claude.ok && codex.ok, "both settings files were read");
    assert.equal(claude.content, undefined, "the raw settings text is not sent");
    assert.equal(codex.content, undefined, "the raw config text is not sent");
    assert.ok(claude.html.includes("acceptEdits") && codex.html.includes(">o3<"), "safe values still show");
    for (const secret of ["home-env-secret", "home-helper-secret", "home-hook-secret", "home-url-secret", "home-toml-secret"]) {
      assert.ok(!run.stdout.includes(secret), `hidden value reached the settings popup response: ${secret}`);
    }
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
}

console.log("config-tree-render-check: ok");
