// Claude-native projection of the shell-sandbox intent into settings.json's `sandbox` key.
// Rendering is not runtime certification: scripts/test/claude-sandbox-enforcement-check.mjs is
// the evidence that a real Claude binary enforces what this returns.
//
// Writable paths and unreadable credentials are deliberately absent here. Claude merges `Edit`
// allow rules (write-scope) into the sandbox's writable paths and `Read`/`Edit` deny rules
// (read-secrets, edit-plans-store) into its denied paths, so the permissions key already carries
// them.

// Commands that run outside the sandbox: they cannot work inside it, would prompt on every call
// there, or must keep their ask rule in the desktop app. Claude matches this list against the text
// of the whole call: `roborepo plans show x | grep y` stays sandboxed. Claude's documentation says
// every command in the call must match, but on 2.1.309 a leading `cd` did not keep a call sandboxed.
// Each entry runs with full filesystem and network access, under the ordinary allow/ask/deny
// rules — keep the list short, and never exclude a command that runs other programs.
//   - docker: talks to the daemon over a Unix socket the sandbox does not open.
//   - gh: calls api.github.com, which reach-allowed-hosts does not list, so every call would prompt.
//   - git push/pull/fetch: SSH cannot pass the sandbox proxy.
//   - git checkout/switch: the desktop app was seen to run a sandboxed `rm` without consulting
//     its ask rule (`claude -p` honors it), so switch-branches would not prompt there. Run
//     outside, they prompt. A chained call (`make x && git switch y`) does not match, stays
//     sandboxed, and in the desktop app may skip the prompt.
//   - roborepo: only the subcommands below. Everything else (`agent-run`, `run`, `browser`,
//     `runtime`, read-only `telemetry`, `scratch`, the rest of `git`) stays in the sandbox.
//     `agent-run`, `run` and `browser run` launch other programs (a test suite, a scenario, a
//     `--serve` command), and an exclusion would hand those programs full access — without a
//     prompt for the pre-approved `agent-run`. When one needs more than the sandbox allows, the
//     retry outside it goes through the permission check. `./bin/roborepo` is the same CLI run
//     from a development checkout.

// roborepo subcommands that run outside the sandbox, each with the reason it cannot run inside.
// Matching is by prefix, so `plans` covers every plans subcommand. The trailing ` *` also matches
// the bare command: on 2.1.309 a no-argument `git fetch` ran outside under `git fetch *`, while
// `env git fetch` stayed sandboxed and failed, so `roborepo web` matches `roborepo web *`.
const ROBOREPO_UNSANDBOXED_SUBCOMMANDS = Object.freeze([
  // Locks and commits the plans store, which edit-plans-store denies to every sandboxed write.
  "plans",
  // Fetches over SSH and calls GitHub through gh, like the git and gh entries above.
  "delivery",
  // Reads your own gh login from the keychain, which read-secrets denies, and calls api.github.com
  // as the agent bot, which reach-allowed-hosts does not list. `github setup` is denied to agents.
  "github status",
  // Adds and removes linked worktrees, whose records under .git/worktrees the sandbox keeps read-only.
  "git worktrees",
  // Starts roborepo's own portal on a local port (allowLocalBinding stays off), and stops it again,
  // which signals a process the sandboxed command did not start.
  "web",
  "web-stop",
  // Write capture state under ~/.roborepo, or capture hooks into harness config. Read-only
  // telemetry (status, report, oracle) stays sandboxed.
  "telemetry install",
  "telemetry control",
  "telemetry disable",
  "telemetry purge",
  "telemetry backup",
  "telemetry mark",
  // These write harness config under ~/.claude and ~/.codex, which the sandbox refuses. A sandboxed
  // run could stop halfway through an update. Each keeps its ask rule outside the sandbox.
  "update",
  "init",
  "uninstall",
  "config",
  "harness",
  "mcp",
  "skill",
  "maintenance",
  "package enable",
  "package disable",
  "package reconcile",
  "package adopt-live",
  "package manage",
  "package dev",
]);

export const CLAUDE_SANDBOX_EXCLUDED_COMMANDS = Object.freeze([
  "docker *",
  "gh *",
  "git push *",
  "git pull *",
  "git fetch *",
  "git checkout *",
  "git switch *",
  ...["roborepo", "./bin/roborepo"].flatMap((cli) =>
    ROBOREPO_UNSANDBOXED_SUBCOMMANDS.map((sub) => `${cli} ${sub} *`),
  ),
]);

// Writable for every checkout, so they belong in user-level settings. Paths that depend on the
// current checkout must not be rendered here: ~/.claude/settings.json applies to every session.
//   - ~/.npm: npm's cache; `npm install` and `npx` fail without it.
// The temporary locations under the home folder (manifest temporaryLocations) are added by
// claudeSandboxSettings. Claude merges `Edit` allow rules into the writable paths, but its docs do
// not say that covers `~/` rules, so they are listed here as well.
export const CLAUDE_SANDBOX_WRITABLE_PATHS = Object.freeze(["~/.npm"]);

// The `~/` temporary locations the write scope covers, as folders. Absolute ones (/tmp) reach the
// sandbox through the scope's Edit rules, which Claude documents merging.
function homeTemporaryLocations(behaviors) {
  const scope = behaviors.find((b) => b.id === "write-scope");
  if (scope?.bucket !== "allow") return [];
  return (scope.paths ?? []).filter((glob) => glob.startsWith("~/")).map((glob) => glob.replace(/\/\*\*$/, ""));
}

// Returns the `sandbox` object, or null when the manifest states no shell-sandbox intent (the
// caller then leaves the key as it found it).
export function claudeSandboxSettings(behaviors) {
  const shell = behaviors.find((b) => b.kind === "shell-sandbox");
  if (!shell) return null;
  if (shell.bucket === "deny") return { enabled: false };

  const sandbox = {
    enabled: true,
    autoAllowBashIfSandboxed: shell.bucket === "allow",
    excludedCommands: [...CLAUDE_SANDBOX_EXCLUDED_COMMANDS],
    filesystem: { allowWrite: [...CLAUDE_SANDBOX_WRITABLE_PATHS, ...homeTemporaryLocations(behaviors)] },
    // Local binding stays off: whether it is narrower than the wildcard listeners the Codex
    // profile rejects is unverified. strictAllowlist stays unset so unlisted hosts prompt.
    network: { allowLocalBinding: false },
  };

  // The exceptions only matter while the credential patterns that hide them are denied.
  const secrets = behaviors.find((b) => b.id === "read-secrets");
  if (secrets?.bucket === "deny" && secrets.readableExceptions?.length) {
    sandbox.filesystem.allowRead = [...new Set(secrets.readableExceptions)];
  }

  for (const hosts of behaviors.filter((b) => b.kind === "network-hosts")) {
    if (hosts.bucket === "ask") continue; // Unlisted hosts already prompt.
    const key = hosts.bucket === "allow" ? "allowedDomains" : "deniedDomains";
    sandbox.network[key] = [...new Set([...(sandbox.network[key] ?? []), ...(hosts.hosts ?? [])])];
  }

  return sandbox;
}
