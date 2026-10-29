#!/usr/bin/env node
// Enforcement tests for scripts/cli/agent-run-policy.mjs.
//
// This module is security-relevant: `Bash(roborepo agent-run:*)` is a single allowlist entry that
// authorizes an arbitrary payload, and checkAgentRun is the only thing standing between that
// prefix and execution. A silent regression here fails OPEN — the prefix keeps matching and the
// payload stops being checked. So the bypasses are pinned explicitly, not just the happy path.
import assert from "node:assert/strict";
import path from "node:path";
import { fileURLToPath } from "node:url";

process.env.ROBOREPO_APP_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const { checkAgentRun, REFUSAL, policyFromManifest } = await import("../cli/agent-run-policy.mjs");

// A fixture manifest rather than the live one: these assertions describe policy MECHANICS, and
// pinning them to whatever buckets ship today would make ordinary manifest edits fail the suite.
// Live-manifest coverage is agent-run-coverage-check.mjs's job.
const manifest = {
  behaviors: [
    { kind: "commands", bucket: "allow", commands: [["git", "status"], ["git", "add"], ["git", "commit"], ["git", "push"]] },
    { kind: "commands", bucket: "ask", commands: [["git", "pull"], ["git", "checkout"], ["rm"]] },
    { kind: "commands", bucket: "deny", commands: [["git", "push", "--force"]] },
    { kind: "tools", bucket: "allow", tools: ["Write"] },
  ],
  commands: { allow: [["npm", "test"], ["npm", "run"], ["node"]] },
};

const refusal = (argv) => {
  const v = checkAgentRun(argv, manifest);
  assert.equal(v.ok, false, `expected refusal for: ${argv.join(" ")}`);
  return v.reason;
};

// --- allowed commands pass -----------------------------------------------------------------
for (const argv of [["npm", "test"], ["npm", "run", "lint"], ["git", "status"], ["git", "commit", "-m", "x"], ["node", "s.mjs"]]) {
  assert.equal(checkAgentRun(argv, manifest).ok, true, `expected pass: ${argv.join(" ")}`);
}

// --- empty / malformed ---------------------------------------------------------------------
assert.equal(refusal([]), REFUSAL.EMPTY);
assert.equal(checkAgentRun(null, manifest).ok, false, "null argv is refused, not thrown on");

// --- nesting: the single most important bypass ----------------------------------------------
// Without this, one allowlisted prefix re-enters the wrapper and launders any payload.
assert.equal(refusal(["roborepo", "agent-run", "git", "push", "--force"]), REFUSAL.NESTED);
assert.equal(refusal(["roborepo", "run", "rm", "-rf", "/"]), REFUSAL.NESTED);
assert.equal(refusal(["/opt/homebrew/bin/roborepo", "update"]), REFUSAL.NESTED, "absolute path to roborepo is still nesting");

// --- destructive git flags, wherever they appear in argv -------------------------------------
assert.equal(refusal(["git", "push", "--force"]), REFUSAL.DESTRUCTIVE_GIT);
assert.equal(refusal(["git", "push", "-f"]), REFUSAL.DESTRUCTIVE_GIT);
assert.equal(refusal(["git", "push", "--force-with-lease"]), REFUSAL.DESTRUCTIVE_GIT);
assert.equal(refusal(["git", "push", "origin", "main", "--force"]), REFUSAL.DESTRUCTIVE_GIT, "flag in trailing position still caught");
assert.equal(refusal(["git", "-c", "k=v", "push", "--force"]), REFUSAL.DESTRUCTIVE_GIT, "global git flags do not hide the force flag");

// --- protected branches, including the forms that are not argv[2] ----------------------------
assert.equal(refusal(["git", "checkout", "main"]), REFUSAL.PROTECTED_BRANCH);
assert.equal(refusal(["git", "switch", "main"]), REFUSAL.PROTECTED_BRANCH, "switch is covered, not just checkout");
assert.equal(refusal(["git", "checkout", "-B", "main"]), REFUSAL.PROTECTED_BRANCH, "-B form is covered");
assert.equal(refusal(["git", "checkout", "master"]), REFUSAL.PROTECTED_BRANCH);
assert.equal(checkAgentRun(["git", "checkout", "-b", "feature/x"], manifest).ok, false, "checkout stays ask-bucketed for non-protected branches");
assert.equal(refusal(["git", "checkout", "-b", "feature/x"]), REFUSAL.ASK_BUCKET, "...and the reason is approval, not branch protection");

// --- bucket semantics ------------------------------------------------------------------------
assert.equal(refusal(["rm", "-rf", "build"]), REFUSAL.ASK_BUCKET, "ask means refuse-with-guidance; a wrapper cannot prompt");
assert.equal(refusal(["git", "pull"]), REFUSAL.ASK_BUCKET);

// --- pushes: allowed to a named feature branch, never to a protected or unresolved one ---------
assert.equal(checkAgentRun(["git", "push", "origin", "feature/x"], manifest).ok, true, "a named feature-branch push runs");
assert.equal(checkAgentRun(["git", "push", "-u", "origin", "feature/x"], manifest).ok, true, "flags do not hide the refspec");
for (const refspec of ["main", "master", "HEAD:main", "feature/x:refs/heads/main", ":main", "main:"]) {
  assert.equal(refusal(["git", "push", "origin", refspec]), REFUSAL.PROTECTED_BRANCH, `push ${refspec}`);
}
assert.equal(refusal(["git", "push", "origin", "feature/x", "main"]), REFUSAL.PROTECTED_BRANCH, "any protected refspec in the list refuses");
assert.equal(refusal(["git", "push"]), REFUSAL.UNRESOLVED_PUSH, "a bare push could land on main");
assert.equal(refusal(["git", "push", "origin"]), REFUSAL.UNRESOLVED_PUSH);
assert.equal(refusal(["git", "push", "origin", "HEAD"]), REFUSAL.UNRESOLVED_PUSH);
assert.equal(refusal(["git", "push", "--all", "origin"]), REFUSAL.UNRESOLVED_PUSH);
assert.equal(refusal(["git", "push", "--repo", "origin", "main"]), REFUSAL.UNRESOLVED_PUSH, "--repo's value is not the remote positional");
// Force pushes the exact-flag check misses are still destructive, whatever branch they target.
for (const argv of [
  ["git", "push", "origin", "+feature/x"],
  ["git", "push", "origin", "+main"],
  ["git", "push", "--force-with-lease=feature/x", "origin", "feature/x"],
  ["git", "push", "origin", "--force-with-lease=feature/x:0123abc", "feature/x"],
  ["git", "push", "origin", "+feature/x:feature/x"],
  ["git", "push", "-uf", "origin", "feature/x"],
]) {
  assert.equal(refusal(argv), REFUSAL.DESTRUCTIVE_GIT, argv.join(" "));
}
assert.equal(checkAgentRun(["git", "push", "-o", "ci.skip", "origin", "feature/x"], manifest).ok, true, "-o's value is not a force flag");
// ':' and '+:' push every matching branch.
assert.equal(refusal(["git", "push", "origin", ":"]), REFUSAL.UNRESOLVED_PUSH);
assert.equal(refusal(["git", "push", "origin", "+:"]), REFUSAL.DESTRUCTIVE_GIT);
// A configured remote.<remote>.push mapping decides where a source-only refspec lands.
const mapped = { pushMappingFor: (remote) => remote === "origin" };
assert.equal(checkAgentRun(["git", "push", "origin", "feature/x"], manifest, mapped).reason, REFUSAL.UNRESOLVED_PUSH, "source-only refspec under a push mapping");
assert.equal(checkAgentRun(["git", "push", "origin", "feature/x:feature/x"], manifest, mapped).ok, true, "an explicit destination is unaffected by the mapping");

// --- fail closed on anything unclassified -----------------------------------------------------
assert.equal(refusal(["curl", "https://example.com"]), REFUSAL.NOT_ALLOWED);
assert.equal(refusal(["bash", "-c", "echo hi"]), REFUSAL.NOT_ALLOWED, "shell binaries are not allowlisted by default");
assert.equal(refusal(["some-new-tool"]), REFUSAL.NOT_ALLOWED, "a tool added later is refused until deliberately permitted");

// --- longest-prefix wins, regardless of manifest ordering -------------------------------------
// ["git","push","--force"] (deny) must beat ["git","push"] (allow) even though allow is declared first.
const buckets = policyFromManifest(manifest);
assert.ok(buckets.deny.some((p) => p.join(" ") === "git push --force"), "deny bucket carries the specific rule");
assert.ok(buckets.allow.some((p) => p.join(" ") === "git push"), "allow bucket carries the general rule");

// --- shell metacharacters are inert, not sanitized --------------------------------------------
// spawnSync without a shell hands these to the binary as literal argv entries. They are NOT
// treated as injection because nothing ever interprets them; this pins that we don't pretend to
// sanitize (which would imply a shell path exists).
assert.equal(checkAgentRun(["npm", "test", "; rm -rf /"], manifest).ok, true, "metacharacters are literal argv, inert without a shell");
assert.equal(checkAgentRun(["npm", "test", "$(whoami)"], manifest).ok, true, "command substitution text is inert without a shell");

console.log("agent-run-policy-check: ok");
