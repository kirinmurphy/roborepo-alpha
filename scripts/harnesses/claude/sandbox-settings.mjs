// Claude-native projection of the shell-sandbox intent into settings.json's `sandbox` key.
// Rendering is not runtime certification: scripts/test/claude-sandbox-enforcement-check.mjs is
// the evidence that a real Claude binary enforces what this returns.
//
// Writable paths and unreadable credentials are deliberately absent here. Claude merges `Edit`
// allow rules (write-scope) into the sandbox's writable paths and `Read`/`Edit` deny rules
// (read-secrets, edit-plans-store) into its denied paths, so the permissions key already carries
// them.

// Commands that cannot work inside the sandbox. Claude matches this list against the text of the
// whole call: `roborepo plans show x | grep y` stays sandboxed. Claude's documentation says every
// command in the call must match, but on 2.1.309 a leading `cd` did not keep a call sandboxed.
// Each entry runs with full filesystem and network access, under the ordinary allow/ask/deny
// rules — keep the list short.
//   - docker: talks to the daemon over a Unix socket the sandbox does not open.
//   - gh: calls api.github.com, which reach-allowed-hosts does not list, so every call would prompt.
//   - git push/pull/fetch: SSH cannot pass the sandbox proxy.
//   - roborepo: plans commands lock and commit the plans store, which edit-plans-store denies to
//     every sandboxed write; `./bin/roborepo` is the same CLI run from a development checkout.
export const CLAUDE_SANDBOX_EXCLUDED_COMMANDS = Object.freeze([
  "docker *",
  "gh *",
  "git push *",
  "git pull *",
  "git fetch *",
  "roborepo *",
  "./bin/roborepo *",
]);

// Writable for every checkout, so they belong in user-level settings. Paths that depend on the
// current checkout must not be rendered here: ~/.claude/settings.json applies to every session.
//   - ~/.npm: npm's cache; `npm install` and `npx` fail without it.
export const CLAUDE_SANDBOX_WRITABLE_PATHS = Object.freeze(["~/.npm"]);

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
    filesystem: { allowWrite: [...CLAUDE_SANDBOX_WRITABLE_PATHS] },
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
