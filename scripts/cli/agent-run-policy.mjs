// Argv policy for `roborepo agent-run` — the ONLY roborepo command an agent's permission
// allowlist should ever carry as a bare `Bash(roborepo agent-run:*)` prefix.
//
// WHY THIS EXISTS
// Claude matches Bash permissions by literal string prefix. A rule like `Bash(roborepo run:*)`
// therefore authorizes EVERY command that starts with those characters — `roborepo run git push
// --force` included. Any wrapper (`bash -c`, `npx`, `env`, plain `run`) has this property: the
// tidy prefix that makes a rule whitelistable is exactly what hides the payload from the matcher.
// So the payload has to be checked somewhere the matcher can't see: here, at execution.
//
// WHY THIS IS ENFORCEABLE (and a PreToolUse hook parsing command text is not)
// runCmd/agent-run use spawnSync(argv[0], argv.slice(1)) with NO shell. There is no `sh -c`, so
// shell metacharacters are never interpreted — `;`, `&&`, `$(...)`, backticks and quotes arrive
// as literal argv entries and are handed to the target binary as ordinary arguments. This
// function therefore inspects the exact token array the OS will execute. There is no string to
// re-parse and no quoting trick that changes the meaning between check and exec.
//
// FAIL CLOSED
// Classification is allowlist-first: a binary not in the manifest's allow set is refused, so a
// tool added later is refused until someone deliberately permits it. `ask` is refused too —
// a wrapper cannot show the user a prompt, and silently running an ask-bucketed command would
// convert "the user approves this" into "the agent approves this". The refusal tells the caller
// to run it directly so the real prompt appears.

// Flags that turn an otherwise-permitted git subcommand into history rewriting. Checked across
// the whole argv, not just a fixed position, so `git -c x=y push --force` is caught too.
const DESTRUCTIVE_GIT_FLAGS = new Set(["--force", "-f", "--force-with-lease", "--mirror", "--delete"]);

// Denied outright regardless of the manifest: moving the working tree onto the trunk branch, or
// pushing to it.
const PROTECTED_BRANCHES = new Set(["main", "master"]);
const BRANCH_MOVING = new Set(["checkout", "switch"]);

export const REFUSAL = {
  EMPTY: "empty",
  NESTED: "nested-wrapper",
  NOT_ALLOWED: "not-allowlisted",
  ASK_BUCKET: "requires-approval",
  DENY_BUCKET: "denied",
  DESTRUCTIVE_GIT: "destructive-git",
  PROTECTED_BRANCH: "protected-branch",
  UNRESOLVED_PUSH: "unresolved-push",
};

// Build {allow,ask,deny} token-prefix lists out of the same manifest that renders the harness
// permission files, so a bucket change updates prompt behavior and wrapper enforcement together
// instead of drifting apart in two hand-maintained lists.
export function policyFromManifest(manifest) {
  const buckets = { allow: [], ask: [], deny: [] };
  for (const b of manifest.behaviors ?? []) {
    if (b.kind !== "commands") continue;
    for (const tokens of b.commands ?? []) buckets[b.bucket]?.push(tokens.map(String));
  }
  for (const tokens of manifest.commands?.allow ?? []) buckets.allow.push(tokens.map(String));
  return buckets;
}

/**
 * Decide whether `argv` may be executed.
 * @param {(remote: string) => boolean} [options.pushMappingFor] whether remote.<remote>.push is set
 * @returns {{ok: true} | {ok: false, reason: string, message: string}}
 */
export function checkAgentRun(argv, manifest, { pushMappingFor = () => false } = {}) {
  if (!Array.isArray(argv) || argv.length === 0) {
    return { ok: false, reason: REFUSAL.EMPTY, message: "usage: roborepo agent-run <cmd> [args...]" };
  }

  // No nesting. Without this, `agent-run agent-run <anything>` (or agent-run run ...) would let a
  // single allowlisted prefix re-enter the wrapper and launder an arbitrary payload through it.
  if (argv[0] === "roborepo" || argv[0].endsWith("/roborepo")) {
    return {
      ok: false,
      reason: REFUSAL.NESTED,
      message: "blocked: agent-run cannot invoke roborepo (no nesting). Run the roborepo command directly.",
    };
  }

  if (argv[0] === "git") {
    const flags = new Set(argv.slice(1));
    for (const flag of DESTRUCTIVE_GIT_FLAGS) {
      if (flags.has(flag)) {
        return {
          ok: false,
          reason: REFUSAL.DESTRUCTIVE_GIT,
          message: `blocked: '${flag}' rewrites or destroys published history. Run it directly if you truly intend it.`,
        };
      }
    }
    const sub = argv[1];
    if (BRANCH_MOVING.has(sub)) {
      // Scan every non-flag argument: `checkout -B main` and `switch --force main` both land on
      // the protected branch without it being argv[2].
      for (const arg of argv.slice(2)) {
        if (!arg.startsWith("-") && PROTECTED_BRANCHES.has(arg)) {
          return {
            ok: false,
            reason: REFUSAL.PROTECTED_BRANCH,
            message: `blocked: refusing to ${sub} onto '${arg}'. Agent work stays on feature branches.`,
          };
        }
      }
    }
    if (sub === "push") {
      const refusal = pushRefusal(argv.slice(2), pushMappingFor);
      if (refusal) return refusal;
    }
  }

  const bucket = classify(argv, policyFromManifest(manifest));
  if (bucket === "deny") {
    return { ok: false, reason: REFUSAL.DENY_BUCKET, message: `blocked: '${argv.join(" ")}' is denied by agent permissions.` };
  }
  if (bucket === "ask") {
    return {
      ok: false,
      reason: REFUSAL.ASK_BUCKET,
      message: `blocked: '${argv.join(" ")}' needs your approval. Run it directly (without agent-run) so the permission prompt appears.`,
    };
  }
  if (bucket === null) {
    return {
      ok: false,
      reason: REFUSAL.NOT_ALLOWED,
      message: `blocked: '${argv[0]}' is not in the agent allowlist. Run it directly, or add it to manifests/inventory/agent-permissions.json.`,
    };
  }
  return { ok: true };
}

// git push options that take their value as the next argument.
const PUSH_VALUE_OPTIONS = new Set(["--repo", "-o", "--push-option", "--receive-pack", "--exec"]);

// A force push in a form the exact-flag check above does not see: `--force-with-lease=<ref>`, or a
// short-option cluster such as `-uf`. Letters after `o` are -o's value, not options.
function forcedPushOption(arg) {
  if (arg.startsWith("--force-with-lease=")) return true;
  const cluster = /^-([A-Za-z]+)$/.exec(arg)?.[1];
  return Boolean(cluster) && cluster.split("o")[0].includes("f");
}

// A push is only allowed when every destination is named and none is protected. This function
// sees argv, not the repository, so it cannot resolve where a bare `git push` or a `HEAD` refspec
// lands; those are refused rather than guessed. `pushMappingFor(remote)` reports whether
// remote.<remote>.push is configured, which redirects a source-only refspec.
function pushRefusal(args, pushMappingFor) {
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === "--all" || args[i] === "--branches") {
      return unresolvedPush(`'${args[i]}' can include a protected branch`);
    }
    if (forcedPushOption(args[i])) return destructivePush(args[i]);
    if (PUSH_VALUE_OPTIONS.has(args[i])) i += 1;
    else if (!args[i].startsWith("-")) positional.push(args[i]);
  }
  const [remote, ...refspecs] = positional;
  if (refspecs.length === 0) return unresolvedPush("a push with no refspec goes wherever the current branch is configured to go");
  for (const spec of refspecs) {
    if (spec.startsWith("+")) return destructivePush(spec);
    // ':' pushes every branch that also exists on the remote, which can include a protected one.
    if (spec === ":") return unresolvedPush("':' pushes every branch that also exists on the remote");
    const colon = spec.indexOf(":");
    if (colon === -1 && pushMappingFor(remote)) {
      return unresolvedPush(`remote.${remote}.push is configured, so '${spec}' may not land on a branch of that name`);
    }
    let dst = colon === -1 || colon === spec.length - 1 ? spec.replace(/:$/, "") : spec.slice(colon + 1);
    dst = dst.replace(/^refs\/heads\//, "");
    if (dst === "HEAD" || dst === "@" || dst.includes("*")) return unresolvedPush(`'${spec}' does not name its destination branch`);
    if (PROTECTED_BRANCHES.has(dst)) {
      return {
        ok: false,
        reason: REFUSAL.PROTECTED_BRANCH,
        message: `blocked: refusing to push to '${dst}'. Push a feature branch and open a pull request instead.`,
      };
    }
  }
  return null;
}

function destructivePush(arg) {
  return {
    ok: false,
    reason: REFUSAL.DESTRUCTIVE_GIT,
    message: `blocked: '${arg}' force-pushes, which rewrites published history. Run it directly if you truly intend it.`,
  };
}

function unresolvedPush(detail) {
  return {
    ok: false,
    reason: REFUSAL.UNRESOLVED_PUSH,
    message: `blocked: ${detail}. Name the remote and destination branch, e.g. 'git push origin my-branch'.`,
  };
}

function startsWith(argv, prefix) {
  return prefix.every((token, index) => argv[index] === token);
}

// Longest match wins so a specific rule beats a general one regardless of manifest order:
// ["git","push","--force"] (deny) must out-rank ["git","push"] (ask).
function classify(argv, buckets) {
  let best = null;
  for (const bucket of ["allow", "ask", "deny"]) {
    for (const prefix of buckets[bucket]) {
      if (!startsWith(argv, prefix)) continue;
      if (!best || prefix.length > best.length) best = { bucket, length: prefix.length };
    }
  }
  return best?.bucket ?? null;
}
