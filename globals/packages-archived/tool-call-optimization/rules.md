## Command Surface

Shell permissions are matched by literal command prefix. A command that is composed, wrapped, or
uniquely shaped therefore cannot be allowlisted — it prompts every time and the prompt text is
unreadable. Keep the surface boring so it can be approved once and stay approved.

- One command per Bash call. Do not chain with `&&`, `;`, or `||` to save a round trip; independent
  calls belong in one message as separate parallel tool calls, which costs nothing and keeps each
  command matchable.
- Start every command with a stable head (`npm run`, `git status`, `node scripts/…`). The head is
  the part a permission rule can match; everything unique should follow it, not precede it.
- Never prefix with `cd`. The working directory persists between calls, and a leading `cd` makes
  every command in that directory unmatchable.
- No decorative output: no `echo "=== … ==="` headers, no `echo "exit=$?"` trailers. They add
  nothing to a captured result and they are what turns one command into an unrepeatable string.
- Do not set inline environment variables (`FOO=bar cmd`) unless the variable is the point of the
  run. They defeat prefix matching the same way `cd` does.
- When logic genuinely needs several steps, put it in a script file under the scratchpad or
  `scripts/`, then invoke the file. `node scripts/foo.mjs` is a stable prefix and the logic is
  reviewable before approval; a multi-line inline one-liner is neither.
- Chain only when the steps must be atomic (a lock, a trap, a transaction) — and say why.

## Verification

- Default to smallest check that proves touched behavior.
- Before testing, discover repo-native commands from package.json, pyproject.toml, Makefile,
  justfile, taskfile, CI config, or docs. Do not invent commands when a repo advertises its own.
- Only run checks implemented in the current repository.
- Prefer formatting, lint, type, and test checks scoped to touched files when supported.
- Prefer targeted smoke tests for edited scripts over full repo checks.
- For package/release workflow edits, prefer syntax checks plus targeted package smoke/lifecycle
  checks; full `npm test` is for broad CLI/runtime changes or explicit release preflight.
- Run full repo checks only for shared app code, build/tooling config, dependency changes,
  generated types, auth/payments/data migrations, CI scripts, broad refactors, cross-cutting
  types/config, CI risk, or explicit user request.
- Never run a full suite just to confirm one command is permitted or one file parses.
- If a full check seems useful but likely slow, state why before running it.
- For long quiet checks, use a timeout/progress wrapper or repo runner when available so silence is
  not mistaken for a hang.
- Avoid watch, verbose, and debug modes unless explicitly requested.
- Keep command output small. Use `roborepo agent-run <command> …` when output may be large: it caps
  the captured output and validates the command against the permission manifest before running it.
  Plain `roborepo run` is the unrestricted interactive equivalent and is deliberately not
  allowlisted — prefer `agent-run` for anything an agent invokes.
- Final response should include `Verified: <command> -> <pass|fail|blocked>` when verification was
  run or attempted.

## Context Cost

- Before broad searches, estimate result size and search the narrowest likely source first.
- Do not recursively search home, global caches, session logs, telemetry spools, or generated
  history unless the user explicitly asks for that scope.
- For config provenance questions, inspect active process args and known config files before
  searching logs.
- For process debugging, start with exact filters such as pidfile, port, script name, or
  `pgrep -fl <pattern>`; use full `ps -axww` only after narrow filters fail, and cap output.
- When a broad search is necessary, exclude high-volume dirs and cap output with targeted patterns.
- Prefer command summaries and bounded tails over full diffs, full test logs, or repeated process
  dumps.

## Temporary Files and Cleanup

- For scratch work, scaffolding, or throwaway test repos, write where the Temporary Files rule
  says (Claude's session scratchpad, or the folder `roborepo scratch <name>` prints), never in the
  project tree.
- A script that needs a directory only for its own run makes it with `mktemp -d` and removes it
  with `trap 'rm -rf "$d"' EXIT`. Put both inside the script file rather than composing them
  inline. The trap still makes cleanup self-contained, and the script keeps the
  invoking command a stable, allowlistable prefix.
- Prefer the trap to a cleanup `rm` after the fact; when you do delete by hand, name the exact path
  you created rather than a glob or a variable.
- `rm` is already allowed where it is safe: Claude's shell sandbox keeps it to the checkout and temp
  folders, and a hook asks before deletes in a checkout on `main` or another protected branch. Do
  not retry a refused delete outside the sandbox, and do not request wider `rm` permissions; surface
  the path for approval instead.
