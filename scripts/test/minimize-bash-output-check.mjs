#!/usr/bin/env node
// Proves both output-minimizer hooks deny watch, verbose, and debug flags where the shell reads them
// as words, and leave commands alone that only mention them inside quotes or a heredoc (commit
// messages, PR bodies, grep patterns).
import assert from "node:assert/strict";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const hooks = [
  ["Claude", path.join(repoRoot, "globals/system/hooks/claude/minimize-bash-output.mjs"), "Bash", "command"],
  ["Codex", path.join(repoRoot, "globals/harnesses/codex/hooks/minimize-bash-output.mjs"), "exec_command", "cmd"],
];

function decide(hook, toolName, key, command) {
  const result = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd: repoRoot, tool_name: toolName, tool_input: { [key]: command } }),
    encoding: "utf8",
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  return JSON.parse(result.stdout).hookSpecificOutput.permissionDecision;
}

const denied = [
  "npm run build --watch",
  "npm test -- --watch",
  "git commit --verbose",
  "node cli.mjs --debug",
  "node cli.mjs --debug=all",
  "--verbose",
  "vitest watch",
  "jest --watch",
  "cd web && npm run build --watch",
];
const notDenied = [
  "npm run build",
  "git log --watcher",
  "node cli.mjs --debugger-port 1",
  "git commit -m 'stop using --watch'",
  `git commit -m "drop --verbose output"`,
  "grep -rn -- '--debug' src",
  "gh pr create --body-file - <<'EOF'\nnpm run build --watch is not denied today\nEOF",
  "cat <<EOF > notes.md\nvitest --watch\nEOF",
];

for (const [name, hook, toolName, key] of hooks) {
  for (const command of denied) {
    assert.equal(decide(hook, toolName, key, command), "deny", `${name} denies: ${command}`);
  }
  for (const command of notDenied) {
    assert.notEqual(decide(hook, toolName, key, command), "deny", `${name} does not deny: ${command}`);
  }
}
console.log("minimize-bash-output-check passed");
