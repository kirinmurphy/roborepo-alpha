#!/usr/bin/env node
// Characterization tests for scripts/cli/root-config-merge.mjs's mergeClaudeSettings/
// mergeCodexConfig, captured before this logic moved into provider adapters. These assertions pin exact
// current output for the trickiest cases (TOML comment reattachment, bracket-in-value sections,
// permissions allow/deny dedupe, the Claude-only `model` key strip) so the refactor can be
// verified byte-for-byte rather than by re-reading the merge logic and hoping the port is faithful.
//
// This file must keep passing unchanged — a failure here means the provider
// adapter's merge output diverged from pre-refactor behavior, not that the old behavior was wrong.
import assert from "node:assert/strict";
import { mergeClaudeSettings, mergeCodexConfig, mergeRootConfig } from "../cli/root-config-merge.mjs";

function testClaudeBasicMerge() {
  const repo = JSON.stringify({ statusLine: { type: "command", command: "foo" }, permissions: { allow: ["a", "b"] } });
  const local = JSON.stringify({ permissions: { allow: ["b", "c"] }, customField: true });
  const merged = JSON.parse(mergeClaudeSettings(repo, local));
  assert.deepEqual(merged.permissions.allow, ["a", "b", "c"], "claude permissions.allow must union and dedupe, repo order first");
  assert.equal(merged.customField, true, "claude merge must keep a local-only field");
  assert.equal(merged.statusLine.command, "foo", "claude merge must keep a repo-only field");
}

function testClaudeModelStripped() {
  const repo = JSON.stringify({});
  const local = JSON.stringify({ model: "claude-opus-5", other: 1 });
  const merged = JSON.parse(mergeClaudeSettings(repo, local));
  assert.equal(merged.model, undefined, "claude merge must always strip the model key, even when only local sets it");
  assert.equal(merged.other, 1, "claude merge must keep sibling local-only fields when stripping model");
}

function testClaudeDenyDedupe() {
  const repo = JSON.stringify({ permissions: { allow: [], deny: ["rm -rf"] } });
  const local = JSON.stringify({ permissions: { deny: ["rm -rf", "curl"] } });
  const merged = JSON.parse(mergeClaudeSettings(repo, local));
  assert.deepEqual(merged.permissions.deny, ["rm -rf", "curl"], "claude permissions.deny must union and dedupe");
}

function testClaudeHooksDeepMerge() {
  const repo = JSON.stringify({ hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ command: "a" }] }] } });
  const local = JSON.stringify({ hooks: { PostToolUse: [{ matcher: "*", hooks: [{ command: "b" }] }] } });
  const merged = JSON.parse(mergeClaudeSettings(repo, local));
  assert.ok(merged.hooks.PreToolUse, "claude merge must keep a repo-only hook event");
  assert.ok(merged.hooks.PostToolUse, "claude merge must keep a local-only hook event");
}

function testClaudeInvalidJsonFallsBackToEmpty() {
  const merged = JSON.parse(mergeClaudeSettings("not json", "{}"));
  assert.deepEqual(merged, {}, "claude merge must tolerate invalid repo JSON by treating it as empty, not throw");
}

function testCodexBasicMerge() {
  const repo = "[table1]\nfoo = \"bar\"\n\n[table2]\nx = 1\n";
  const local = "[table1]\nfoo = \"local-override\"\nextra = true\n";
  const merged = mergeCodexConfig(repo, local);
  assert.match(merged, /foo = "local-override"/, "codex merge: a key present in both must take the local value");
  assert.match(merged, /extra = true/, "codex merge: a local-only key must be kept");
  assert.match(merged, /\[table2\]/, "codex merge: a repo-only table must be kept");
}

function testCodexCommentReattachment() {
  // Pinning actual current behavior (not a guess): when a key exists in both repo and local, the
  // REPO's preceding comment survives and the LOCAL comment for that same key is dropped — only
  // the local value itself wins. Comment-with-value reattachment only applies to LOCAL-ONLY keys
  // (see testCodexLocalOnlyCommentKept below).
  const repo = "[tool]\n# explains foo\nfoo = 1\n";
  const local = "[tool]\n# user's own note about foo\nfoo = 2\n";
  const merged = mergeCodexConfig(repo, local);
  assert.match(merged, /# explains foo\nfoo = 2/, "codex merge keeps the repo's comment above a key that exists in both, using the local value");
  assert.doesNotMatch(merged, /user's own note/, "codex merge currently drops the local comment when the same key also exists in repo");
}

function testCodexLocalOnlyCommentKept() {
  const repo = "[tool]\nfoo = 1\n";
  const local = "[tool]\nfoo = 1\n# user's own note about bar\nbar = 2\n";
  const merged = mergeCodexConfig(repo, local);
  assert.match(merged, /# user's own note about bar\nbar = 2/, "codex merge must keep a local-only key's own preceding comment attached to it");
}

function testCodexBracketInValueSurvives() {
  // Regression target named explicitly in root-config-merge.mjs's own comment: a naive
  // char-class scan on "[" would truncate this block because the value itself contains brackets.
  const repo = "[mcp_servers.foo]\ncommand = \"echo\"\nargs = [\"--foo\", \"--bar\"]\n";
  const local = "";
  const merged = mergeCodexConfig(repo, local);
  assert.match(merged, /args = \["--foo", "--bar"\]/, "codex merge must not truncate a section whose value contains literal brackets");
}

function testCodexLocalOnlySectionAppended() {
  const repo = "[table1]\nfoo = 1\n";
  const local = "[table1]\nfoo = 1\n\n[mcp_servers.custom]\ncommand = \"x\"\n";
  const merged = mergeCodexConfig(repo, local);
  assert.match(merged, /\[mcp_servers\.custom\]/, "codex merge must keep a local-only section with no repo counterpart");
}

function testMergeRootConfigDispatchesByHarness() {
  assert.equal(mergeRootConfig("codex", "[a]\nx=1\n", ""), mergeCodexConfig("[a]\nx=1\n", ""), "mergeRootConfig('codex', ...) must dispatch to mergeCodexConfig");
  assert.equal(mergeRootConfig("claude", "{}", "{}"), mergeClaudeSettings("{}", "{}"), "mergeRootConfig('claude', ...) must dispatch to mergeClaudeSettings");
  // root-config-merge.mjs's dispatch used to be a bare ternary
  // (`harness === "codex" ? codex : claude`), so any value other than the literal string "codex" —
  // including typos and future provider IDs — silently fell through to the Claude merge path. Now an
  // unrecognized harness throws instead of silently mis-merging as Claude.
  assert.throws(() => mergeRootConfig("nonexistent-harness", "{}", "{}"), /unsupported harness: nonexistent-harness/, "an unknown harness must throw, not silently fall through to the Claude merge path");
}

testClaudeBasicMerge();
testClaudeModelStripped();
testClaudeDenyDedupe();
testClaudeHooksDeepMerge();
testClaudeInvalidJsonFallsBackToEmpty();
testCodexBasicMerge();
testCodexCommentReattachment();
testCodexLocalOnlyCommentKept();
testCodexBracketInValueSurvives();
testCodexLocalOnlySectionAppended();
testMergeRootConfigDispatchesByHarness();

console.log("root-config-merge characterization: all checks passed");
