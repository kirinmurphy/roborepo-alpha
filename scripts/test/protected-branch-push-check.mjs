#!/usr/bin/env node
// Proves agents can push feature branches but not protected ones (main, master, the remote's
// default branch), and never force-push, through both guards:
//   - the PreToolUse hook, which reads the command text before it runs and is the only thing that
//     approves a push without a prompt, and
//   - the pre-push git hook, which agent shells reach through a core.hooksPath override and which
//     must still run the repo's own hooks.
// A permission prefix rule cannot express this, so it is only checkable by running the hooks.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const claudeHooks = path.join(repoRoot, "globals/system/hooks/claude");
const codexHooks = path.join(repoRoot, "globals/harnesses/codex/hooks");
const hook = path.join(claudeHooks, "protected-branch-push.mjs");
const gitHooks = path.join(repoRoot, "globals/system/git-hooks");

// Both harnesses install their own copy of the PreToolUse hook; a fix landed in one must land in the
// other. The git hooks have one source, installed into each harness home.
assert.equal(fs.readFileSync(path.join(codexHooks, "protected-branch-push.mjs"), "utf8"), fs.readFileSync(hook, "utf8"),
  "protected-branch-push.mjs differs between Claude and Codex");
// The .sh files are helpers the hooks source, not hooks git runs.
for (const name of fs.readdirSync(gitHooks).filter((name) => !name.endsWith(".sh"))) {
  assert.ok(fs.statSync(path.join(gitHooks, name)).mode & 0o111, `git hook ${name} is executable`);
}

// Hermetic git: no user, system, or environment-injected config, so a developer's own
// core.hooksPath cannot leak in. An agent shell injects the installed backstop through
// GIT_CONFIG_COUNT/KEY/VALUE, which would refuse this test's own setup pushes.
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-protected-push-"));
const gitEnv = {
  ...process.env,
  GIT_CONFIG_GLOBAL: path.join(tmp, "gitconfig"),
  GIT_CONFIG_NOSYSTEM: "1",
  GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com",
  GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com",
};
for (const key of Object.keys(gitEnv)) {
  if (/^GIT_CONFIG_(?:COUNT|PARAMETERS|KEY_\d+|VALUE_\d+)$/.test(key)) delete gitEnv[key];
}
delete gitEnv.ROBOREPO_PROTECTED_BRANCHES;
// The machine's own GitHub agent identity must not lift the gh api denial in the default cases, and a
// token exported on the machine (or in CI) must not keep the agent cases from lifting it.
for (const name of ["GH_CONFIG_DIR", "GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) delete gitEnv[name];
gitEnv.ROBOREPO_STATE_ROOT = path.join(tmp, "default-state");
// An agent shell carries the core.hooksPath override itself; the "human" git here must not.
for (const key of Object.keys(gitEnv)) if (/^GIT_CONFIG_(COUNT|KEY_\d+|VALUE_\d+)$/.test(key)) delete gitEnv[key];
fs.writeFileSync(gitEnv.GIT_CONFIG_GLOBAL, "");
const agentEnv = { ...gitEnv, GIT_CONFIG_COUNT: "1", GIT_CONFIG_KEY_0: "core.hooksPath", GIT_CONFIG_VALUE_0: gitHooks };

function git(cwd, args, env = gitEnv) {
  return spawnSync("git", args, { cwd, encoding: "utf8", env });
}
function gitOk(cwd, ...args) {
  const r = git(cwd, args);
  assert.equal(r.status, 0, `git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

const remote = path.join(tmp, "remote.git");
const work = path.join(tmp, "work");
gitOk(tmp, "init", "-q", "--bare", "-b", "trunk", remote);
gitOk(tmp, "init", "-q", "-b", "main", work);
gitOk(work, "commit", "-q", "--allow-empty", "-m", "init");
gitOk(work, "remote", "add", "origin", remote);
gitOk(work, "push", "-q", "origin", "main", "main:trunk");
gitOk(work, "remote", "set-head", "origin", "trunk");
gitOk(work, "branch", "-q", "--set-upstream-to=origin/main");
gitOk(work, "switch", "-q", "-c", "feat");

function decide(command, { cwd = work, toolName = "Bash", env = {}, hookPath = hook, key = "command", event = "PreToolUse" } = {}) {
  const result = spawnSync(process.execPath, [hookPath], {
    input: JSON.stringify({ cwd, hook_event_name: event, tool_name: toolName, tool_input: { [key]: command } }),
    encoding: "utf8",
    env: { ...gitEnv, ROBOREPO_GIT_HOOKS_DIR: gitHooks, ...env },
  });
  assert.equal(result.status, 0, `hook exited ${result.status}: ${result.stderr}`);
  if (!result.stdout.trim()) return "defer";
  const output = JSON.parse(result.stdout).hookSpecificOutput;
  assert.equal(output.hookEventName, event);
  return event === "PermissionRequest" ? output.decision.behavior : output.permissionDecision;
}

const cases = [
  // Verified pushes are allowed: the hook is what lets agents push without a prompt.
  ["git push -u origin feat", "allow"],
  ["git push origin HEAD", "allow"],
  ["git push origin v1.0", "allow"],
  ["git push origin feat 2>&1", "allow"],
  [`cd ${work} && git push origin feat`, "allow"],
  // Anything beyond pushes is left to the sandbox and permission rules, so the allow never covers it.
  // A command that only mentions a push asks nothing, unless something in the command could run
  // that text as a script.
  ["git status && echo git push origin main", "defer"],
  ["git log --grep push", "defer"],
  ["git show HEAD -- push", "defer"],
  ["bash -c 'echo git push'", "defer"],
  ["echo git push origin main | sh", "ask"],
  ["echo 'git push origin main' | bash", "ask"],
  ["printf 'git push origin main' | xargs -I{} sh -c {}", "ask"],
  ["echo git push origin main > x.sh; bash x.sh", "ask"],
  // A shell glued to a bracket or redirect, or filled in by a substitution, still counts.
  ["echo $(echo git push --no-verify origin HEAD:main | sh)", "ask"],
  ["(echo git push origin main | sh)", "ask"],
  ["echo git push origin main |sh)", "ask"],
  ["echo git push origin main | bash>out.log", "ask"],
  ["echo git push origin main | sh<&0", "ask"],
  ["echo git push origin main | `which sh`", "ask"],
  ["echo git push origin main | $(which sh)", "ask"],
  ["echo git push origin main > x; $(command -v sh) x", "ask"],
  ["echo git push origin main | env -S sh", "ask"],
  ["echo git push origin main | env -Ssh", "ask"],
  ["echo git push origin main | \"$(which sh)\"", "ask"],
  ["echo git push origin main >x\n>|y sh x", "ask"],
  ["echo git push origin main | {fd}>x sh", "ask"],
  // Arithmetic and array substitutions are not a program.
  ["echo $(( $(nproc) + 1 )) && git log --grep push", "defer"],
  ["files=( $(git ls-files) ); git log --grep push", "defer"],
  // Interpreters other than shells can run the text too.
  ["echo git push --no-verify origin HEAD:main | python3 -c 'import os,sys;os.system(sys.stdin.read())'", "ask"],
  ["echo git push origin main | perl -e 'system(<STDIN>)'", "ask"],
  ["echo git push origin main | awk '{system($0)}'", "ask"],
  // An apostrophe in a comment opens no quote, and `$'…'` keeps its escapes.
  ["# it's a note\ngit push origin main", "deny"],
  ["echo hi # don't\ngit push origin main", "deny"],
  ["echo hi # it's done\necho git push origin main | sh", "ask"],
  ["cat > x.sh <<'EOF'\ngit push origin main\nEOF\n# don't worry\nbash x.sh", "deny"],
  ["echo $'a\\'' ; echo git push origin main | sh", "ask"],
  ["echo $'a\\'' ; echo git push origin main | python3", "ask"],
  // A comment ends where bash ends it: at a newline, or at the backtick that closes its substitution.
  ["echo `#x`; sudo git push origin main", "ask"],
  ["echo `true #x`; command git push origin main", "ask"],
  ["echo git push origin main $(true)#x | sh", "ask"],
  ["echo git push origin main\\ #x | sh", "ask"],
  ["echo git push origin main `#x` | sh", "ask"],
  ["true # note \\\nsudo git push origin main", "ask"],
  // Where `#` is not a comment, the command after it is still read.
  ["x=${line%% #*}; git push origin main", "deny"],
  ["x=${a:- #}; sudo git push origin main", "ask"],
  ["echo a\\\\ #it's\necho git push origin main | sh", "ask"],
  ["(true)#it's\necho git push origin main | sh", "ask"],
  ["case a in a)#it's\necho git push origin main | sh;; esac", "ask"],
  // A comment hides only itself, and its words are never refspecs.
  ["git push origin feat # it's\nrm -rf src", "defer"],
  ["git push origin feat # it's\necho git push origin main | sh", "ask"],
  ["git push -u origin feat # PR targets main", "allow"],
  ["git push origin feat # --force", "allow"],
  ["# it's\nx=${a:- #}; git push origin main", "deny"],
  // A push in a subshell reads its refspec without the closing parenthesis.
  ["(true; git push origin main)", "deny"],
  ["sh -c \"echo a\\ #b; git push origin main\"", "deny"],
  ["echo <(true)#x; git push origin main", "deny"],
  ["[[ $a =~ ^(x|y)#$ ]] && git push origin main", "deny"],
  ["[[ $a == @(x)#y ]] && git push origin main", "deny"],
  ["(echo a)#x; git push origin main", "defer"],
  ["node <<'EOF'\nconsole.log(`it's`)\nEOF\ngit commit -m 'fix #2'; git push origin main", "ask"],
  // A body that a program reads and that unbalances the quotes hides nothing: the hook asks.
  ["bash <<EOF\necho don't\nEOF\necho 'x #y'; git push origin main", "ask"],
  ["python3 - <<'EOF'\ns = 'it\\'s'\nEOF\ngit commit -m 'fix #2'; git push origin main", "ask"],
  ["python3 - <<'EOF'\nprint('ok')\nEOF", "defer"],
  ["echo $(true; git push origin feat:main)", "deny"],
  ["python3 -c 'import os; os.system(\"git push origin main\")'", "ask"],
  ["echo 'all: ; git push origin main' > Makefile; make", "ask"],
  ["python3 -c \"import subprocess; subprocess.run(['git','push','origin','main'])\"", "ask"],
  ["python3 -c 'subprocess.run([\"git\",\"push\",\"origin\",\"main\"])'", "ask"],
  // Operators and interpreter names inside quoted prose are not commands.
  ["git commit -m \"Guard git push; make the hook clearer\"", "defer"],
  ["git commit -m \"Guard git push (make it clearer)\"", "defer"],
  ["git commit -m 'Hook: echo git push | node now asks'", "defer"],
  ["gh pr create --title 'Ask about git push (node -e)' --body x", "defer"],
  ["rg -n \"git push|python3\" scripts", "defer"],
  ["git log --grep push && eval \"$X\"", "ask"],
  ["xargs git log push", "ask"],
  ["git push origin feat && rm -rf build", "defer"],
  ["git push origin feat > push.log", "defer"],
  ["bash -lc 'git push origin feat'", "defer"],
  ["git push origin --delete feat", "ask"],
  // Ways to point git away from the pre-push backstop, or to another destination, ask: Claude has no
  // push ask rule to fall back on.
  ["GIT_CONFIG_COUNT=0 git push origin feat", "ask"],
  ["git -c core.hooksPath=/dev/null push origin feat", "ask"],
  ["git -c remote.origin.push=+refs/heads/main:refs/heads/main push origin", "ask"],
  ["npm test && git -c core.hooksPath=/dev/null push origin feat", "ask"],
  // A push the hook cannot read (behind a wrapper, nested, or aliased) asks.
  ["env git push origin feat", "ask"],
  ["command git push origin feat", "ask"],
  ["(git push origin feat)", "ask"],
  ["{ git push origin feat; }", "ask"],
  ["echo $(git push origin feat)", "ask"],
  ["printf x | xargs git push origin", "ask"],
  ["git --git-dir .git push origin feat", "ask"],
  ["git -c alias.p=push p origin main", "ask"],
  ["env git -c core.hooksPath=/dev/null push origin main", "ask"],
  ["git commit -m 'fix the git push docs'", "defer"],
  // Heredoc bodies are data unless a shell reads them, so prose that names a push asks nothing.
  [`git commit -m "$(cat <<'EOF'\nTeach the hook about git push\n\nDon't ask twice\nEOF\n)"`, "defer"],
  [`gh pr create --title t --body "$(cat <<'EOF'\n- git push now asks\nEOF\n)"`, "defer"],
  ["cat > notes.md <<'EOF'\nthen git push origin feat\nEOF", "defer"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\nbash<x", "deny"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\n(bash<x)", "deny"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\n$(which sh) x", "deny"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\n`which bash` x", "deny"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\nenv -S bash x", "deny"],
  ["tee x <<'EOF'\ngit push --no-verify origin HEAD:main\nEOF\nsh<x", "ask"],
  ["git tag -a v1 -F - <<'EOF'\nnotes about git push\nEOF", "defer"],
  ["cat > x <<'EOF'\ngit push origin main\nEOF\n\"$(which sh)\" x", "deny"],
  ["2>/dev/null cat > notes.md <<'EOF'\nthen git push origin feat\nEOF", "defer"],
  ["bash <<'EOF'\n(git push origin feat)\nEOF", "ask"],
  ["cat <<'EOF' | sh\necho $(git push origin feat)\nEOF", "ask"],
  ["echo '<<EOF'\n(git push origin feat)\nEOF", "ask"],
  ["echo x # <<EOF\n(git push origin feat)\nEOF", "ask"],
  ["cat <<EOF\n(git push origin feat)", "ask"],
  // A body is data only when nothing can run it: an unquoted body's substitutions run, and a body
  // piped on, read by a shell from a variable or xargs, or written to a script that runs, is read.
  ["cat <<EOF\n$(git push --no-verify origin HEAD:main)\nEOF", "ask"],
  ["cat <<EOF\n`git push origin feat`\nEOF", "ask"],
  ["cat <<EOF |\nenv git push --no-verify origin HEAD:main\nEOF\nsh", "ask"],
  ["$SHELL <<EOF\nenv git push --no-verify origin HEAD:main\nEOF", "ask"],
  ["xargs -I{} sh -c {} <<EOF\nenv git push origin feat\nEOF", "ask"],
  ["tee >(sh) <<EOF\nenv git push origin feat\nEOF", "ask"],
  ["cat > x.sh <<EOF\nenv git push origin feat\nEOF\nbash x.sh", "ask"],
  ["cat > x.sh <<'EOF'\nenv git push origin feat\nEOF\n./x.sh", "ask"],
  // A data body in push form is neither a push nor denied.
  ["cat > README.md <<'EOF'\n```\ngit push origin main\n```\nEOF", "defer"],
  ["git commit -F - <<'EOF'\ngit push origin main is blocked now\nEOF", "defer"],
  [`gh pr create --body "$(cat <<'EOF'\n- git push asks\n\nMade with [a tool](https://example.com/x)\nEOF\n)"`, "defer"],
  // A backslash-newline joins the lines, as the shell does.
  ["git \\\npush origin main", "deny"],
  ["git push \\\n  origin feat", "allow"],
  // Quotes and escapes inside a word do not hide it.
  ["git pu''sh origin main", "deny"],
  ['git "pu"sh origin main', "deny"],
  ["git pu\\sh origin main", "deny"],
  ["git $'push' origin main", "deny"],
  ["git $'pu\\x73h' origin main", "deny"],
  ["git push origin $'feat'", "allow"],
  ["git {push,} origin main", "ask"],
  ["git pu{s,}h origin main", "ask"],
  ["git pu\\\nsh origin main", "deny"],
  ['git pu$"s"h origin main', "deny"],
  ["git pu`true`sh origin main", "ask"],
  ["git pu$(true)sh origin main", "ask"],
  // Scripts handed to a shell another way.
  ["eval 'git push origin feat'", "ask"],
  ["watch 'git push origin feat'", "ask"],
  ["env -S 'git push origin feat'", "ask"],
  ["bash <<< 'git push origin feat'", "ask"],
  ["source /dev/stdin <<<'git push origin feat'", "ask"],
  ["cat <<< 'git push origin feat'", "defer"],
  // Words the shell fills in.
  ["git $CMD origin main && echo push", "ask"],
  ["git $(echo push) origin main", "ask"],
  ["echo push origin main | xargs git", "ask"],
  ["$GIT push origin main", "ask"],
  ['"$(which git)" push origin main', "ask"],
  // A change to what the push reads, earlier in the same command, asks.
  ["export GIT_CONFIG_COUNT=0; git push origin feat", "ask"],
  ["unset GIT_CONFIG_COUNT; git push origin feat", "ask"],
  ["GIT_DIR=/elsewhere; git push origin feat", "ask"],
  ["git config remote.origin.push refs/heads/feat:refs/heads/main; git push origin", "ask"],
  ["git remote set-url origin /elsewhere && git push origin feat", "ask"],
  ["(git config core.hooksPath /dev/null); git push origin feat", "ask"],
  ["X=1; git push origin feat", "defer"],
  ["git remote -v && git push origin feat", "defer"],
  ["git config --get remote.origin.url && git push origin feat", "defer"],
  ["git config get remote.origin.url && git push origin feat", "defer"],
  ["git config --file f x && git push origin feat", "defer"],
  ["source ./activate && git push origin feat", "ask"],
  ["git push --no-verify origin feat", "ask"],
  ["git push origin main", "deny"],
  ["git push origin HEAD:main", "deny"],
  ["git push origin feat:refs/heads/main", "deny"],
  ["git push origin +main", "deny"],
  ["git push origin :main", "deny"],
  ["git push origin --delete main", "deny"],
  ["git push origin master", "deny"],
  // The plans store branch: only `roborepo plans` pushes it, with hooks off.
  ["git push origin repo-plans", "deny"],
  ["git push origin HEAD:repo-plans", "deny"],
  ["git push origin --delete repo-plans", "deny"],
  // The remote's default branch is protected even when it is not named main or master.
  ["git push origin feat:trunk", "deny"],
  ["git -C . push origin main", "deny"],
  [`cd ${work} && git push origin main`, "deny"],
  ["bash -lc 'git push origin main'", "deny"],
  ["git push origin feat && git push origin main", "deny"],
  ["git push --all", "ask"],
  ["git push --mirror origin", "ask"],
  ["git push origin $BRANCH", "ask"],
  ["git push origin 'refs/heads/*:refs/heads/*'", "ask"],
  ["git push origin :", "ask"],
  // Force pushes are denied wherever they land, in every spelling.
  ["git push --force origin feat", "deny"],
  ["git push origin feat --force", "deny"],
  ["git push --force-with-lease=feat origin feat", "deny"],
  ["git push origin --force-with-lease=feat:0123abc feat", "deny"],
  ["git push -uf origin feat", "deny"],
  ["git push origin +feat", "deny"],
  ["git push origin +:", "deny"],
  ["git push -o ci.skip origin feat", "allow"],
  // A redirect does not hide where a push lands, and a remote branch delete always asks: Claude
  // renders no ask rule for git push, so the hook is what asks.
  ["git push origin main 2>/dev/null", "deny"],
  ["git push origin HEAD:main > out.log", "deny"],
  ["npm test && git push origin HEAD:main 2>/dev/null", "deny"],
  ["git push origin feat 2>/dev/null", "allow"],
  ["git push origin :other", "ask"],
  ["git push --delete origin", "ask"],
];
// gh commands that skip git: denied in any flag position, since the prefix rules only see the
// leading words. Other gh commands are left to the permission rules.
cases.push(
  ["gh --repo=owner/repo api -X PATCH repos/o/r/git/refs/heads/main", "deny"],
  ["git push origin feat && gh -R o/r api repos/o/r", "deny"],
  // Agents never merge a pull request (merge-pull-requests), in either flag position.
  ["gh -R owner/repo pr merge 12 --admin", "deny"],
  ["gh pr merge 12", "deny"],
  // bash's `NAME+=value` is a leading assignment too, so the program after it is still checked.
  ["X+=1 gh pr merge 12", "deny"],
  ["X+=1 git push origin main", "deny"],
  ["gh -R owner/repo pr create --head feat", "defer"],
  ["gh pr view 12", "defer"],
);
// The hook's gh deny list must cover every command the manifest denies, in the flag-first form the
// prefix rules miss.
const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "manifests/inventory/agent-permissions.json"), "utf8"));
for (const command of manifest.behaviors.find((b) => b.id === "change-github-directly").commands) {
  cases.push([`gh -R owner/repo ${command.slice(1).join(" ")} x`, "deny"]);
}
for (const [command, expected] of cases) {
  assert.equal(decide(command), expected, command);
}
// As the github-agent identity `gh api` is allowed: the package's Git config file is installed, the
// hook's GH_CONFIG_DIR is exactly the identity's gh dir (or unset, under Codex), and the command does not change
// which account gh acts as. Every other denied gh command stays denied.
{
  const installIdentity = (root) => {
    const file = path.join(root, "package-runtime", "github-agent-identity", "gitconfig");
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "");
  };
  const stateRoot = path.join(tmp, "agent-state");
  const notInstalled = path.join(tmp, "agent-state-off");
  installIdentity(stateRoot);
  const agentDir = path.join(stateRoot, "github-agent", "gh");
  // Codex's config, as the package renders it: the bot's gh for every shell. Codex hooks read it;
  // Claude hooks ignore it.
  const codexHome = path.join(tmp, "codex-home");
  const codexConfig = (dir, { tokens = true } = {}) => {
    fs.mkdirSync(codexHome, { recursive: true });
    fs.writeFileSync(path.join(codexHome, "config.toml"), `model = "x"\n\n[shell_environment_policy.set]\nGH_CONFIG_DIR = "${dir}"\n${tokens ? 'GH_TOKEN = ""\nGITHUB_TOKEN = ""\n' : ""}\n[other]\nGH_CONFIG_DIR = "${agentDir}"\n`);
  };
  codexConfig(agentDir);
  const asAgent = { ROBOREPO_STATE_ROOT: stateRoot, GH_CONFIG_DIR: agentDir, CODEX_HOME: codexHome };
  const codexOptions = { toolName: "exec_command", hookPath: path.join(codexHooks, "protected-branch-push.mjs"), key: "cmd" };
  // A Codex session started with a -c override of its shell environment never shows the override to
  // its own hook, so starting one is refused while the identity is on; other -c settings are fine.
  for (const options of [{}, codexOptions]) {
    for (const [command, expected] of [
      [`codex exec -c 'shell_environment_policy.set.GH_TOKEN="x"' 'gh api repos/o/r'`, "deny"],
      [`codex --config shell_environment_policy.inherit=all exec 'gh api repos/o/r'`, "deny"],
      [`codex exec --config=shell_environment_policy.set.GH_CONFIG_DIR=/tmp/x 'gh api repos/o/r'`, "deny"],
      [`codex exec -c 'model="o3"' 'list files'`, "defer"],
    ]) {
      assert.equal(decide(command, { ...options, env: asAgent }), expected, `${options.hookPath ? "Codex" : "Claude"}: ${command}`);
    }
  }
  assert.equal(decide(`codex exec -c 'shell_environment_policy.set.GH_TOKEN="x"' 'gh api repos/o/r'`, { env: {} }), "defer", "without the identity a codex -c override is not ours to refuse");
  for (const options of [{}, codexOptions]) {
    const label = options.hookPath ? "Codex" : "Claude";
    for (const command of [
      "gh api repos/o/r", "gh api graphql -f query=x", "gh -R o/r api repos/o/r/pulls",
      // Reads that mention merge state are not merges.
      "gh api repos/o/r/pulls/12 --jq .mergeable",
      "gh api -H 'Accept: application/vnd.github.raw+json' repos/o/r/contents/README.md",
      "gh api --header 'Accept: application/vnd.github+json' repos/o/r/pulls",
      "gh api graphql -F number=12 -f query='{ viewer { login } }'",
      "gh api repos/o/r/pulls --jq '.[].merged_at'",
      "gh api graphql -f query='{ repository(owner: \"o\", name: \"r\") { pullRequest(number: 1) { mergeable mergeStateStatus mergeQueueEntry { id } } } }'",
      "git log --merges -1 && gh api repos/o/r",
      // Only the operation is checked for a merge, never the data the call sends.
      "gh api repos/o/r/pulls/1/comments/2/replies -f body='I tested mergePullRequest'",
      "gh api repos/o/r/issues/1/comments -f body=\"see /repos/o/r/pulls/2/merge\"",
      "gh api repos/o/r/issues/1/comments -F body=@- <<'B'\nmergePullRequest works now\nB",
      "gh api graphql -f query='mutation($id: ID!, $body: String!) { addPullRequestReviewThreadReply(input: {pullRequestReviewThreadId: $id, body: $body}) { comment { id } } }' -f id=x -f body='tested mergePullRequest'",
    ]) {
      assert.equal(decide(command, { ...options, env: asAgent }), "defer", `${label} allows as agent: ${command}`);
      // Codex hooks never see the shell's GH_CONFIG_DIR; a Claude hook without it belongs to a session
      // whose gh acts as the user.
      assert.equal(decide(command, { ...options, env: { ROBOREPO_STATE_ROOT: stateRoot, GH_CONFIG_DIR: "", CODEX_HOME: codexHome } }), options.hookPath ? "defer" : "deny", `${label} with the hook's GH_CONFIG_DIR unset: ${command}`);
      assert.equal(decide(command, { ...options, env: { ...asAgent, GH_CONFIG_DIR: path.join(tmp, "other-gh") } }), "deny", `${label} denies other GH_CONFIG_DIR: ${command}`);
      // gh prefers an inherited token or host over the bot's config dir.
      for (const name of ["GH_TOKEN", "GITHUB_TOKEN", "GH_ENTERPRISE_TOKEN", "GITHUB_ENTERPRISE_TOKEN", "GH_HOST"]) {
        assert.equal(decide(command, { ...options, env: { ...asAgent, [name]: "x" } }), "deny", `${label} denies with ${name} inherited: ${command}`);
      }
      assert.equal(decide(command, { ...options, env: { ROBOREPO_STATE_ROOT: notInstalled, GH_CONFIG_DIR: path.join(notInstalled, "github-agent", "gh") } }), "deny", `${label} denies without the installed identity: ${command}`);
      assert.equal(decide(command, { ...options, env: { ROBOREPO_STATE_ROOT: notInstalled } }), "deny", `${label} denies without identity: ${command}`);
    }
    // The command itself must not change which account or host gh acts as.
    for (const command of [
      "GH_CONFIG_DIR=/x gh api repos/o/r",
      "GH_TOKEN=abc gh api repos/o/r",
      "GITHUB_TOKEN=abc gh api repos/o/r",
      "GH_ENTERPRISE_TOKEN=abc gh api repos/o/r",
      "GITHUB_ENTERPRISE_TOKEN=abc gh api repos/o/r",
      "GH_HOST=example.com gh api repos/o/r",
      "env -u GH_CONFIG_DIR gh api repos/o/r",
      "env --unset=GH_CONFIG_DIR gh api repos/o/r",
      "env gh api repos/o/r",
      "env GH_TOKEN=abc gh api repos/o/r",
      "unset GH_CONFIG_DIR; gh api repos/o/r",
      "export GH_TOKEN=abc; gh api repos/o/r",
      "export GH_CONFIG_DIR=/x && gh api repos/o/r",
      "GH_CONFIG_DIR=/x; gh api repos/o/r",
      "bash -c 'unset GH_CONFIG_DIR; gh api repos/o/r'",
      "(export GH_TOKEN=abc; gh api repos/o/r)",
      "export GH_TOKEN+=$OTHER; gh api repos/o/r",
      "GITHUB_TOKEN+=x gh api repos/o/r",
    ]) {
      assert.equal(decide(command, { ...options, env: asAgent }), "deny", `${label} denies a command that changes gh's identity: ${command}`);
    }
    for (const command of [
      "gh auth token", "gh -R o/r pr merge 12", "gh secret set X", "gh release create v1", "gh workflow run x",
      // Merging through the API is still merging, which agents never do.
      "gh api -X PUT repos/O/R/pulls/12/merge",
      "gh api --method PUT /repos/O/R/pulls/12/merge -f merge_method=squash",
      "gh api repos/O/R/merges -f base=main -f head=feature",
      "gh api graphql -f query='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { enablePullRequestAutoMerge(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { enqueuePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'",
      "gh api graphql -f query='mutation { mergeBranch(input: {repositoryId: \"x\", base: \"main\", head: \"f\"}) { clientMutationId } }'",
      "gh api -X POST repos/O/R/merge-upstream -f branch=main",
      "gh api \"/repos/O/R/pulls/12/merge?x=1\" -XPUT",
      // A query written in a heredoc or a variable is on the command line too.
      "gh api graphql -F query=@- <<'Q'\nmutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }\nQ",
      "Q='mutation { mergePullRequest(input: {pullRequestId: \"x\"}) { clientMutationId } }'; gh api graphql -f query=\"$Q\"",
      // An operation the shell fills in, or a missing query, cannot be checked for a merge.
      "EP=repos/O/R/pulls/12/merge; gh api -X PUT \"$EP\"",
      "gh api -X PUT \"$EP\"",
      "gh api graphql -f query=\"mutation { $M }\"",
      "gh api graphql -f query=\"$(cat q.graphql)\"",
      // Only the query's own argument says whether its `$` is single-quoted, not other text that matches.
      "gh api graphql -f query=\"$M\"; echo query='$M'",
      "echo \"'query=$M'\"; gh api graphql -f query=\"$M\"",
      "gh api graphql -f id=x",
      "gh api -iX PUT repos/O/R/pulls/12/merge",
      // An Authorization header replaces the bot's token, in every spelling gh accepts.
      "gh api -H 'Authorization: Bearer x' user",
      "gh api -H 'authorization: token x' user",
      "gh api -H'Authorization: token x' user",
      "gh api -iH 'AUTHORIZATION: token x' user",
      "gh api --header 'Authorization: token x' user",
      "gh api --header='Authorization: token x' user",
      "gh api -H \"$AUTH\" user",
      // A GraphQL query from a file or stdin cannot be checked for a merge mutation.
      "gh api graphql -F query=@request.graphql",
      "gh api graphql --field query=@request.graphql",
      "gh api graphql -Fquery=@request.graphql",
      "gh api graphql --input request.json",
      "gh api /graphql --input=request.json",
    ]) {
      assert.equal(decide(command, { ...options, env: asAgent }), "deny", `${label} still denies as agent: ${command}`);
    }
  }
  // A partial enable installs the gitconfig but leaves Codex's shells on another gh: the Codex hook
  // then keeps gh api denied.
  const codexUnset = { ROBOREPO_STATE_ROOT: stateRoot, GH_CONFIG_DIR: "", CODEX_HOME: codexHome };
  for (const [label, write] of [
    ["another GH_CONFIG_DIR", () => codexConfig(path.join(tmp, "users-own-gh"))],
    ["tokens not emptied", () => codexConfig(agentDir, { tokens: false })],
    ["no config", () => fs.rmSync(path.join(codexHome, "config.toml"), { force: true })],
  ]) {
    write();
    assert.equal(decide("gh api repos/o/r", { ...codexOptions, env: codexUnset }), "deny", `Codex with ${label} denies gh api`);
  }
  codexConfig(agentDir);
  // A layer Codex reads above the user config can give its shells another gh: a project's
  // .codex/config.toml in the session's folder or above it, a profile file, or a profile table.
  {
    const projectConfig = path.join(work, ".codex", "config.toml");
    const parentConfig = path.join(tmp, ".codex", "config.toml");
    const profileConfig = path.join(codexHome, "work.config.toml");
    const userConfig = path.join(codexHome, "config.toml");
    const userText = fs.readFileSync(userConfig, "utf8");
    const write = (file, text) => {
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, text);
    };
    const codexDecides = (env) => decide("gh api repos/o/r", { ...codexOptions, env });
    const setTable = (lines) => `[shell_environment_policy.set]\n${lines}\n`;
    for (const [label, file, text, expected] of [
      ["project sets another GH_CONFIG_DIR", projectConfig, setTable(`GH_CONFIG_DIR = "${path.join(tmp, "users-own-gh")}"`), "deny"],
      ["project above the session sets GH_TOKEN", parentConfig, setTable('GH_TOKEN = "x"'), "deny"],
      ["project sets GITHUB_TOKEN as a dotted key", projectConfig, 'shell_environment_policy.set.GITHUB_TOKEN = "x"\n', "deny"],
      ["project sets GH_HOST in an inline table", projectConfig, '[shell_environment_policy]\nset = { GH_HOST = "example.com" }\n', "deny"],
      ["project spells GH_TOKEN with an escape", projectConfig, setTable('"GH\\u005fTOKEN" = "x"'), "deny"],
      ["project drops GH_CONFIG_DIR with include_only", projectConfig, '[shell_environment_policy]\ninclude_only = ["PATH"]\n', "deny"],
      ["profile file sets GH_TOKEN", profileConfig, setTable('GH_TOKEN = "x"'), "deny"],
      ["profile table sets GH_TOKEN", userConfig, `${userText}\n[profiles.p.shell_environment_policy.set]\nGH_TOKEN = "x"\n`, "deny"],
      ["project keeps the bot's values", projectConfig, setTable(`GH_CONFIG_DIR = "${agentDir}"\nGH_TOKEN = ""`), "defer"],
      ["project changes other settings", projectConfig, `model = "y"\ndeveloper_instructions = """\nGH_TOKEN = "x"\n"""\n${setTable('PATH_EXTRA = "/x"')}`, "defer"],
      // A triple quote in a comment or inside a single-line string opens no multi-line string.
      ["project hides GH_TOKEN after a commented triple quote", projectConfig, `model = "x" # """\n${setTable('GH_TOKEN = "x"')}`, "deny"],
      ["project hides GH_TOKEN after a quoted triple quote", projectConfig, `model = '"""'\n${setTable('GH_TOKEN = "x"')}`, "deny"],
      ["project leaves a multi-line string open", projectConfig, `developer_instructions = '''\n${setTable('GH_TOKEN = "x"')}`, "deny"],
      ["project names GH_TOKEN only in a comment", projectConfig, `model = "x" # GH_TOKEN stays the bot's\n`, "defer"],
    ]) {
      write(file, text);
      try {
        assert.equal(codexDecides(codexUnset), expected, `Codex with ${label}`);
        if (expected === "deny") assert.equal(codexDecides(asAgent), "deny", `Codex with ${label}, GH_CONFIG_DIR in the hook's environment`);
      } finally {
        if (file === userConfig) fs.writeFileSync(userConfig, userText);
        else fs.rmSync(path.dirname(file).endsWith(".codex") ? path.dirname(file) : file, { recursive: true, force: true });
      }
    }
    // A project config that cannot be read cannot show that it keeps the bot.
    write(projectConfig, "");
    fs.chmodSync(projectConfig, 0o000);
    try {
      if (process.getuid?.() !== 0) assert.equal(codexDecides(codexUnset), "deny", "Codex with an unreadable project config");
    } finally {
      fs.rmSync(path.dirname(projectConfig), { recursive: true, force: true });
    }
    // A codex home that exists but cannot be listed may hold a profile that changes gh.
    fs.chmodSync(codexHome, 0o100);
    try {
      if (process.getuid?.() !== 0) assert.equal(codexDecides(codexUnset), "deny", "Codex with an unlistable profile folder");
    } finally {
      fs.chmodSync(codexHome, 0o755);
    }
    assert.equal(codexDecides(codexUnset), "defer", "Codex without override layers");
  }
  // The default state root is ~/.roborepo when ROBOREPO_STATE_ROOT is unset.
  installIdentity(path.join(tmp, ".roborepo"));
  assert.equal(decide("gh api repos/o/r", { env: { HOME: tmp, ROBOREPO_STATE_ROOT: "", GH_CONFIG_DIR: path.join(tmp, ".roborepo", "github-agent", "gh") } }), "defer", "default state root");
}
// Each command start scans only its own command, so a long chain stays fast.
{
  const started = Date.now();
  decide("; a=b".repeat(20000));
  decide("a=1\n".repeat(20000) + "echo $a");
  decide("\n".repeat(40000) + "echo $a");
  decide("echo hi #c\n".repeat(20000) + "git push origin main");
  assert.ok(Date.now() - started < 5000, "long chains of assignments or lines took over 5 seconds");
}
// Codex runs a command whose hook result is "ask" without prompting, so its copy turns every ask
// into a deny. It knows it is Codex's from its directory, in this repo and where it is installed.
const codexHook = path.join(codexHooks, "protected-branch-push.mjs");
const installedHome = path.join(tmp, "home");
for (const dir of [".codex", ".claude"]) {
  fs.mkdirSync(path.join(installedHome, dir, "hooks"), { recursive: true });
  fs.copyFileSync(hook, path.join(installedHome, dir, "hooks", "protected-branch-push.mjs"));
}
const askCases = [
  ...cases.filter(([, expected]) => expected === "ask").map(([command]) => command),
  "git push origin feat --no-verify",
  `sh -c 'b=main; git push origin "$b"'`,
];
for (const command of askCases) {
  assert.equal(decide(command), "ask", `Claude asks: ${command}`);
  assert.equal(decide(command, { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex denies: ${command}`);
}
const installedCodex = path.join(installedHome, ".codex", "hooks", "protected-branch-push.mjs");
const installedClaude = path.join(installedHome, ".claude", "hooks", "protected-branch-push.mjs");
assert.equal(decide("git push --no-verify origin feat", { toolName: "exec_command", hookPath: installedCodex }), "deny", "installed Codex copy denies an ask");
assert.equal(decide("git push --no-verify origin feat", { hookPath: installedClaude }), "ask", "installed Claude copy still asks");
// Codex keeps its other decisions: exec_command sends the command as `cmd`.
for (const [command, expected] of [["git push origin feat", "allow"], ["git push origin main", "deny"], ["gh pr view 12", "defer"]]) {
  assert.equal(decide(command, { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), expected, `Codex cmd: ${command}`);
}
// Native approval requests use the branch guard to approve only verified generic pushes. Chaining another command or losing the backstop must never inherit an allow.
const permissionHook = path.join(codexHooks, "permission-check.mjs");
for (const event of ["PreToolUse", "PermissionRequest"]) {
  for (const [toolName, key] of [["Bash", "command"], ["exec_command", "cmd"]]) {
    const options = { event, toolName, key, hookPath: permissionHook, env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: path.join(tmp, "permission-state") } };
    for (const [command, expected] of [
      ["git push origin feat", "allow"],
      ["git push origin main", "deny"],
      ["git push origin feat --no-verify", "deny"],
      ["git push --all origin", "deny"],
      ["git push origin feat && touch chained.txt", "deny"],
    ]) assert.equal(decide(command, options), expected, `command permissions ${toolName}: ${command}`);
    assert.equal(decide("git push origin feat", { ...options, env: { ...options.env, ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "deny", "command permissions deny without the push backstop");
  }
}
const overrideState = path.join(tmp, "push-override-state");
fs.mkdirSync(overrideState);
for (const [tokens, bucket] of [
  [["git", "push"], "ask"],
  [["git", "push", "origin", "feat"], "ask"],
  [["git"], "ask"],
  [["git"], "deny"],
]) {
  fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({
    commands: { [tokens.join(" ")]: { tokens, bucket } },
  }));
  assert.equal(decide("git push origin feat", {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), bucket === "deny" ? "deny" : "defer", "personal restrictions survive push approval");
}

fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({ commands: {} }));
for (const command of ['git push origin "feat"', "git push origin feat && git push origin special"]) {
  assert.equal(decide(command, {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), "defer", "only literal single pushes may receive automatic approval");
}
for (const bucket of ["ask", "deny"]) {
  const tokens = ["git", "push", "origin", "special"];
  fs.writeFileSync(path.join(overrideState, "command-overrides.json"), JSON.stringify({
    commands: { [tokens.join(" ")]: { tokens, bucket } },
  }));
  assert.equal(decide("git push origin feat && git push origin special", {
    hookPath: permissionHook, event: "PermissionRequest",
    env: { REPO_ROOT: repoRoot, ROBOREPO_STATE_ROOT: overrideState },
  }), "defer", "a later push must retain its native personal restriction");
}

console.log("push approval checks passed: both hook events, shell payloads, protected/force denials, and personal overrides");
assert.equal(decide("git push origin release", { env: { ROBOREPO_PROTECTED_BRANCHES: "release, prod" } }), "deny", "extra protected names");
assert.equal(decide("git push origin main", { toolName: "exec_command" }), "deny", "Codex shell tool");
assert.equal(decide("git push origin main", { toolName: "Read" }), "defer", "non-shell tool");
// Without the backstop installed, nothing approves a push: the permission prompt stays.
assert.equal(decide("git push origin feat", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "defer", "no backstop, no allow");
assert.equal(decide("git push origin main", { env: { ROBOREPO_GIT_HOOKS_DIR: path.join(tmp, "missing") } }), "deny", "a protected push is still denied");

// With no recorded remote default branch, a push may land on it; this hook cannot ask the remote.
gitOk(work, "remote", "set-head", "origin", "-d");
assert.equal(decide("git push origin feat"), "ask", "unknown remote default branch asks");
assert.equal(decide("git push origin feat", { toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", "Codex denies an unknown remote default branch");
assert.equal(decide("git push origin main"), "deny", "main is protected regardless");
gitOk(work, "remote", "set-head", "origin", "trunk");

// A bare `git push` resolves where git itself would send it.
assert.equal(decide("git push"), "allow", "bare push from a feature branch with no upstream");
gitOk(work, "switch", "-q", "main");
assert.equal(decide("git push"), "deny", "bare push from main");
assert.equal(decide("git push origin"), "deny", "bare push to a remote from main");
gitOk(work, "switch", "-q", "-c", "tracks-main", "--track", "origin/main");
gitOk(work, "config", "push.default", "upstream");
assert.equal(decide("git push"), "deny", "feature branch whose upstream is main, push.default=upstream");
gitOk(work, "config", "push.default", "matching");
assert.equal(decide("git push"), "ask", "push.default=matching");
gitOk(work, "config", "--unset", "push.default");
gitOk(work, "config", "remote.origin.push", "refs/heads/feat:refs/heads/main");
assert.equal(decide("git push origin feat"), "ask", "a source-only refspec follows remote.<name>.push");
assert.equal(decide("git push origin feat:feat"), "allow", "an explicit destination does not");
gitOk(work, "config", "--unset", "remote.origin.push");

// pre-push backstop: git hands it the real destination refs.
gitOk(work, "switch", "-q", "-c", "feature");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "work");
let r = git(work, ["push", "-q", "origin", "feature"], agentEnv);
assert.equal(r.status, 0, `feature push should pass: ${r.stderr}`);
for (const refspec of ["feature:main", "feature:refs/heads/master", "feature:trunk"]) {
  r = git(work, ["push", "-q", "origin", refspec], agentEnv);
  assert.notEqual(r.status, 0, `${refspec} should be refused`);
  assert.match(r.stderr, /protected branch/, refspec);
}
assert.notEqual(git(work, ["push", "-q", "origin", ":main"], agentEnv).status, 0, "deleting main should be refused");
// main is protected by name and, here, as the remote's default branch too; it is reported once.
gitOk(work, "remote", "set-head", "origin", "main");
r = git(work, ["push", "-q", "origin", "feature:main"], agentEnv);
assert.match(r.stderr, /protected branch\(es\): main is blocked/, "each blocked branch is named once");
gitOk(work, "remote", "set-head", "origin", "trunk");

// Force pushes are refused from the refs themselves, however the command spelled them.
gitOk(work, "commit", "-q", "--allow-empty", "-m", "published");
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0);
gitOk(work, "reset", "-q", "--hard", "HEAD~1");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "rewritten");
for (const args of [["origin", "--force", "feature"], ["origin", "+feature"], ["--force-with-lease", "origin", "feature"]]) {
  r = git(work, ["push", "-q", ...args], agentEnv);
  assert.notEqual(r.status, 0, `force push ${args.join(" ")} should be refused`);
  assert.match(r.stderr, /not a fast-forward/, args.join(" "));
}
// A remote ref holding commits this repo lacks cannot be checked for fast-forward, so it is refused.
const other = path.join(tmp, "other");
gitOk(tmp, "clone", "-q", "-b", "feature", remote, other);
gitOk(other, "commit", "-q", "--allow-empty", "-m", "elsewhere");
gitOk(other, "push", "-q", "origin", "feature");
r = git(work, ["push", "-q", "--force", "origin", "feature"], agentEnv);
assert.notEqual(r.status, 0, "force over unknown remote commits should be refused");
assert.match(r.stderr, /does not have/);
gitOk(work, "pull", "-q", "--rebase", "origin", "feature");
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0, "a fast-forward after integrating is allowed");

// With no recorded remote HEAD, the backstop asks the remote for its default branch.
gitOk(work, "remote", "set-head", "origin", "-d");
r = git(work, ["push", "-q", "origin", "feature:trunk"], agentEnv);
assert.notEqual(r.status, 0, "the remote's default branch is protected without a recorded HEAD");
assert.match(r.stderr, /protected branch/);
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0, "a feature push still passes");
gitOk(work, "remote", "set-head", "origin", "trunk");
// Without the agent override, the same push goes through: the backstop only applies to agent shells.
r = git(work, ["push", "-q", "origin", "feature:main"]);
assert.equal(r.status, 0, `a human push is not affected: ${r.stderr}`);

// The plans store branch is refused by the backstop too, and so are hand-made commits and merges in a
// checkout of it. `roborepo plans` runs its own Git with hooks off, so only hand-made ones get here.
r = git(work, ["push", "-q", "origin", "HEAD:repo-plans"], agentEnv);
assert.notEqual(r.status, 0, "pushing to repo-plans should be refused");
assert.match(r.stderr, /plans store/, "the refusal names the plans store");
gitOk(work, "switch", "-q", "-c", "repo-plans", "HEAD~1");
r = git(work, ["commit", "-q", "--allow-empty", "-m", "by hand"], agentEnv);
assert.notEqual(r.status, 0, "a commit on repo-plans should be refused");
assert.match(r.stderr, /roborepo plans/, "the commit refusal points at the plans commands");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv);
assert.notEqual(r.status, 0, "a merge commit on repo-plans should be refused");
assert.match(r.stderr, /plans store/);
gitOk(work, "merge", "--abort");
gitOk(work, "switch", "-q", "feature");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "elsewhere"], agentEnv).status, 0, "other branches still commit");
gitOk(work, "branch", "-q", "-D", "repo-plans");

// The backstop refuses a merge commit or a rebase on a protected branch, however the command reached
// git; a feature branch still merges and rebases, and a person's own shell is unaffected.
gitOk(work, "switch", "-q", "-c", "master", "HEAD~1");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv);
assert.notEqual(r.status, 0, "a merge commit on master should be refused");
assert.match(r.stderr, /protected branch "master"/);
gitOk(work, "merge", "--abort");
r = git(work, ["rebase", "-q", "feature"], agentEnv);
assert.notEqual(r.status, 0, "rebasing master should be refused");
assert.match(r.stderr, /a rebase into protected branch "master"/);
r = git(work, ["rebase", "-q", "feature", "master"], agentEnv);
assert.notEqual(r.status, 0, "rebasing master by name should be refused");
// A merge that stops (--no-commit, or a conflict) and is finished by `git commit` is refused too.
r = git(work, ["merge", "-q", "--no-ff", "--no-commit", "feature"]);
assert.equal(r.status, 0, `a human --no-commit merge starts: ${r.stderr}`);
r = git(work, ["commit", "-q", "--no-edit"], agentEnv);
assert.notEqual(r.status, 0, "finishing a merge on master with git commit should be refused");
assert.match(r.stderr, /finishing a merge into protected branch "master"/);
gitOk(work, "merge", "--abort");
gitOk(work, "switch", "-q", "-c", "side", "HEAD~1");
assert.equal(git(work, ["merge", "-q", "--no-ff", "--no-edit", "feature"], agentEnv).status, 0, "a feature branch takes merges");
gitOk(work, "switch", "-q", "master");
r = git(work, ["merge", "-q", "--no-ff", "--no-edit", "side"]);
assert.equal(r.status, 0, `a human merge is not affected: ${r.stderr}`);
gitOk(work, "switch", "-q", "feature");
gitOk(work, "branch", "-q", "-D", "master", "side");

// The repo's own hooks still run under the override, from .git/hooks or its own core.hooksPath.
const log = path.join(tmp, "hook.log");
const repoHook = (dir, name) => {
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, name), `#!/bin/sh\necho "${name} $(cat | wc -l | tr -d ' ')" >> "${log}"\n`, { mode: 0o755 });
};
repoHook(path.join(work, ".git", "hooks"), "pre-push");
repoHook(path.join(work, ".git", "hooks"), "pre-commit");
gitOk(work, "commit", "-q", "--allow-empty", "-m", "chained");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "chained"], agentEnv).status, 0);
assert.equal(git(work, ["push", "-q", "origin", "feature"], agentEnv).status, 0);
assert.deepEqual(fs.readFileSync(log, "utf8").trim().split("\n").slice(-2), ["pre-commit 0", "pre-push 1"], "repo hooks chained, with pre-push stdin intact");

const customHooks = path.join(work, ".custom-hooks");
repoHook(customHooks, "pre-commit");
fs.rmSync(path.join(work, ".git", "hooks", "pre-commit"));
gitOk(work, "config", "core.hooksPath", ".custom-hooks");
fs.writeFileSync(log, "");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "custom"], agentEnv).status, 0);
assert.equal(fs.readFileSync(log, "utf8").trim(), "pre-commit 0", "repo-configured core.hooksPath is honored");

// An exported CDPATH with its own .custom-hooks must not redirect the relative core.hooksPath.
fs.mkdirSync(path.join(tmp, "decoy", ".custom-hooks"), { recursive: true });
fs.writeFileSync(log, "");
assert.equal(git(work, ["commit", "-q", "--allow-empty", "-m", "cdpath"], { ...agentEnv, CDPATH: path.join(tmp, "decoy") }).status, 0);
assert.equal(fs.readFileSync(log, "utf8").trim(), "pre-commit 0", "CDPATH does not redirect the repo's hooks");

// Deletes ask only in a checkout that has a protected branch checked out. The fixtures live under the
// system temp folder, which the hook treats as temp, so ROBOREPO_TEMP_ROOTS narrows the temp list
// to one scratch folder for these cases.
const scratch = path.join(tmp, "scratch");
const onMain = path.join(tmp, "on-main");
const onFeature = path.join(tmp, "on-feature");
fs.mkdirSync(scratch);
for (const [dir, branch] of [[onMain, "main"], [onFeature, "feature"]]) {
  gitOk(tmp, "init", "-q", "-b", branch, dir);
  fs.writeFileSync(path.join(dir, "a.txt"), "a");
  gitOk(dir, "add", "a.txt");
  gitOk(dir, "commit", "-q", "-m", "init");
}
gitOk(onFeature, "branch", "main");
fs.symlinkSync(onMain, path.join(scratch, "main-link"));
fs.mkdirSync(path.join(onMain, "src"));
fs.symlinkSync(path.join(onMain, "src"), path.join(scratch, "src-link"));
const temps = { ROBOREPO_TEMP_ROOTS: scratch, TMPDIR: scratch };
const deleteCases = [
  [onMain, "rm a.txt", "ask"],
  // A comment hides only what bash hides.
  [onMain, "echo `#x`; rm -rf build", "ask"],
  [onMain, "echo hi # it's\nrm -rf build", "ask"],
  [onMain, "echo hi # note \\\nrm -rf build", "ask"],
  [onMain, "x=${a:- #}; rm -rf build", "ask"],
  [onMain, "echo <(true)#x; rm -rf build", "ask"],
  [onMain, "[[ x =~ (a)#b ]] || rm -rf build", "ask"],
  [onMain, "rm -rf build", "ask"],
  [onMain, `rm ${path.join(scratch, "x")}`, "defer"],
  [onMain, 'rm "$TARGET"', "ask"],
  [onMain, "rm *.log", "ask"],
  [onMain, "rmdir empty", "ask"],
  [onMain, "unlink a.txt", "ask"],
  [onMain, "git rm a.txt", "ask"],
  [onMain, "git clean -fdx", "ask"],
  [onMain, "git clean -n", "defer"],
  [onMain, "git reset --hard", "ask"],
  [onMain, "git reset --soft HEAD~1", "defer"],
  [onMain, "git restore a.txt", "ask"],
  [onMain, "git restore --staged a.txt", "defer"],
  [onMain, "git restore --staged --worktree a.txt", "ask"],
  [onMain, "git stash drop", "ask"],
  [onMain, "git stash", "defer"],
  [onMain, "find . -name '*.tmp' -delete", "ask"],
  [onMain, "find . -name x -exec rm {} ;", "ask"],
  [onMain, `find ${scratch} -delete`, "defer"],
  [onMain, "find . -name x", "defer"],
  [onMain, "ls | xargs rm", "ask"],
  [onMain, "sh -c 'rm a.txt'", "ask"],
  [onMain, `cd ${onFeature} && rm a.txt`, "defer"],
  [onMain, `rm ${path.join(onFeature, "a.txt")}`, "defer"],
  [onMain, `git -C ${onFeature} rm a.txt`, "defer"],
  [onMain, "grep rm notes.txt", "defer"],
  [onFeature, "rm a.txt", "defer"],
  [onFeature, "git reset --hard", "defer"],
  [onFeature, `rm ${path.join(onMain, "a.txt")}`, "ask"],
  [onFeature, `git -C ${onMain} clean -f`, "ask"],
  // .git belongs to the checkout around it.
  [onMain, "rm -rf .git", "ask"],
  [onMain, "rm .git/index", "ask"],
  // Shell keywords, grouping, subshells, and command substitution do not hide the program.
  [onMain, 'for f in *.log; do rm "$f"; done', "ask"],
  [onMain, "if true; then rm a.txt; fi", "ask"],
  [onMain, "(rm a.txt)", "ask"],
  [onMain, "{ rm a.txt; }", "ask"],
  [onMain, "echo $(rm a.txt)", "ask"],
  [onMain, 'echo "$(rm a.txt)"', "ask"],
  [onMain, "echo `rm a.txt`", "ask"],
  [onMain, "echo 'rm a.txt'", "defer"],
  // Nor do wrappers.
  [onMain, "command rm a.txt", "ask"],
  [onMain, "env -i rm a.txt", "ask"],
  [onMain, "nohup rm a.txt", "ask"],
  [onMain, "time rm a.txt", "ask"],
  [onMain, "sudo -u someone rm a.txt", "ask"],
  [onMain, "FOO=1 rm a.txt", "ask"],
  // xargs options that take a value, and git stash options before the subcommand.
  [onMain, "ls | xargs -n 1 rm", "ask"],
  [onMain, "ls | xargs -I {} rm {}", "ask"],
  [onMain, "ls | xargs -P 4 rm -f", "ask"],
  [onMain, "ls | xargs -n 1 echo", "defer"],
  [onMain, "git stash -q drop", "ask"],
  // An expanded word is judged by its literal part: a $TMPDIR path is temp, a glob under a main
  // checkout is that checkout.
  [onMain, 'rm -rf "$TMPDIR/foo"', "defer"],
  [onMain, "rm -rf ${TMPDIR}/foo", "defer"],
  [scratch, `rm -rf ${onMain}/*.txt`, "ask"],
  [onFeature, `rm -rf ${onMain}/src/*`, "ask"],
  [onFeature, `rm -rf ${onFeature}/src/*`, "defer"],
  // cd -- and pushd are followed.
  [scratch, `cd -- ${onMain} && rm a.txt`, "ask"],
  [scratch, `pushd ${onMain} && rm a.txt`, "ask"],
  // Deleting a folder that holds a main checkout takes the checkout with it.
  [scratch, `rm -rf ${tmp}`, "ask"],
  [scratch, `rm -rf ${onFeature}`, "defer"],
  // A cd inside a subshell or substitution ends with it; popd and cd - return.
  [onMain, `(cd ${scratch} && rm x); rm a.txt`, "ask"],
  [onMain, `echo $(cd ${scratch}); rm a.txt`, "ask"],
  [onMain, `pushd ${scratch} && rm x && popd && rm a.txt`, "ask"],
  [onMain, `cd ${scratch} && rm x && cd - && rm a.txt`, "ask"],
  [onMain, `(cd ${scratch} && rm x)`, "defer"],
  // cd into $TMPDIR is followed, so a temp delete after it does not ask.
  [onMain, 'cd "$TMPDIR" && rm -rf x', "defer"],
  // A cd to a folder that does not exist fails, so the delete runs where the shell already was.
  [onMain, "cd $TMPDIR/sub && rm x", "ask"],
  [onMain, `sh -c 'cd ${scratch}/missing; rm a.txt'`, "ask"],
  [onMain, "cd $SOMEWHERE && rm x", "ask"],
  // A substitution inside double quotes does not hide the commands after the string.
  [onMain, 'git commit -m "$(cat x)" && rm a.txt', "ask"],
  [onMain, 'echo "a $(pwd) b"; rm a.txt', "ask"],
  [onMain, 'echo "`pwd`" ; rm a.txt', "ask"],
  [onMain, 'X="$(date)"; rm a.txt', "ask"],
  [onMain, 'echo "$(cd x) ; rm a.txt"', "defer"],
  // cd - with a redirect, popd after a popd in a subshell, and moves to unknown folders.
  [onMain, `cd ${scratch} && cd - >/dev/null && rm a.txt`, "ask"],
  [onMain, `pushd ${scratch} && (popd) && popd && rm a.txt`, "ask"],
  [scratch, `cd ${onMain} && cd $FOO && cd - && rm a.txt`, "ask"],
  [scratch, `pushd ${onMain} && pushd $FOO && popd && rm a.txt`, "ask"],
  // A cd to a substitution is not followed; it is not a bare cd home.
  [onMain, "cd $(git rev-parse --show-toplevel) && rm -rf src", "ask"],
  [onMain, "cd `pwd` && rm a.txt", "ask"],
  [onMain, `pushd ${scratch} && pushd $(pwd) && rm x`, "defer"],
  [onMain, 'cd ">x" && rm a.txt', "ask"],
  [onMain, "rm$(echo ' -rf') src", "ask"],
  [onMain, "find . -delete`true`", "ask"],
  // The words after a substitution stay part of its command.
  [onMain, "git -C $(pwd) clean -f", "ask"],
  [onMain, "rm -rf $TMPDIR/$(date)", "defer"],
  [onMain, "find $(pwd) -delete", "ask"],
  [onMain, `rm -rf "$(echo x)" && cd ${scratch} && rm x`, "ask"],
  [onMain, `echo $(cd ${scratch} && rm x) && rm -rf "$TMPDIR/y"`, "defer"],
  [onMain, `pushd ${scratch} >/dev/null && pushd >/dev/null && rm a.txt`, "ask"],
  // Bare cd goes home and bare pushd swaps; redirects around the target are dropped.
  [onMain, `cd ${scratch} && cd && cd - && rm x`, "defer"],
  [onMain, `pushd ${scratch} && pushd && rm a.txt`, "ask"],
  [onMain, `cd ${scratch} 2>/dev/null && rm x`, "defer"],
  [scratch, `cd ${onMain} >/dev/null && rm a.txt`, "ask"],
  [onMain, `cd > out ${scratch} && rm x`, "defer"],
  // `$TMPDIR/..` is judged where it lands, and a symlinked folder by what it points to.
  [scratch, `rm "$TMPDIR/../${path.basename(onMain)}/a.txt"`, "ask"],
  [scratch, `rm ${path.join(scratch, "main-link", "a.txt")}`, "ask"],
  [scratch, `rm ${path.join(scratch, "main-link")}`, "defer"],
  // Wrapper options: `command -p` takes no value, `sudo -u` does.
  [onMain, "command -p rm a.txt", "ask"],
  [onMain, "sudo -u root rm a.txt", "ask"],
  // Operands written into find -exec rm and after xargs rm count, wherever the command runs.
  [scratch, `find ${scratch} -maxdepth 0 -exec rm ${path.join(onMain, "a.txt")} {} \\;`, "ask"],
  [onMain, `cd ${scratch} && printf x | xargs rm ${path.join(onMain, "a.txt")}`, "ask"],
  [onMain, `cd ${scratch} && printf x | xargs rm`, "defer"],
  // A branch switch earlier in the command decides what a later delete or merge lands on.
  [onFeature, "git switch main && rm a.txt", "ask"],
  [onFeature, "git checkout main && rm a.txt", "ask"],
  [onFeature, "git checkout - && rm a.txt", "ask"],
  [onFeature, "git checkout -- a.txt && rm a.txt", "defer"],
  [onFeature, "git switch -c other && rm a.txt", "defer"],
  // Through a symlink: a trailing slash, a glob, and `..` reach what the link points to.
  [scratch, `rm -rf ${path.join(scratch, "main-link")}/`, "ask"],
  [scratch, `rm -rf ${path.join(scratch, "main-link")}/*`, "ask"],
  [scratch, `find ${path.join(scratch, "main-link")}/ -delete`, "ask"],
  [scratch, `rm -rf ${path.join(scratch, "src-link")}/../a.txt`, "ask"],
  // A cd to a missing folder may follow a mkdir, so the folder it names counts too.
  [scratch, `mkdir d && cd d && rm -rf ../../${path.basename(onMain)}`, "ask"],
  // Through any number of such moves, the folder before them stays possible.
  [onMain, `pushd ${scratch}/nope; rm -rf a.txt`, "ask"],
  [onMain, `cd ${scratch}/n1; cd ${scratch}/n2; rm -rf a.txt`, "ask"],
  [onMain, `cd ${scratch}/n1 || cd ${scratch}/n2; rm -rf a.txt`, "ask"],
  [onMain, `cd ${scratch}/n1; pushd ${scratch}; popd; rm -rf a.txt`, "ask"],
  [onMain, `cd ${scratch}/n1; pushd ${scratch}/n2; rm -rf a.txt`, "ask"],
  [onMain, `cd ${scratch} && cd ${scratch} && rm -rf x`, "defer"],
  [onMain, `${Array.from({ length: 18 }, (_, k) => `cd ../q${k}`).join("; ")}; rm -rf a.txt`, "ask"],
  [onMain, `${Array.from({ length: 18 }, (_, k) => `cd ../q${k}`).join("; ")}; git merge feature`, "deny"],
  // A failed cd or pushd leaves `cd -` and `popd` pointing where they did before it.
  [onMain, `cd ${scratch}; cd ${scratch}/n1; cd -; rm -rf a.txt`, "ask"],
  [onMain, `pushd ${scratch}; pushd ${scratch}/n1; popd; rm -rf a.txt`, "ask"],
  [onMain, `pushd ${scratch}; pushd ${scratch}/n1; pushd; rm -rf a.txt`, "ask"],
  // Past the folder cap, a relative cd back out of a collapsed folder still counts the start.
  [onMain, `mkdir -p n1/n2; cd n1/n2; ${Array.from({ length: 18 }, (_, k) => `cd ${scratch}/z${k}`).join("; ")}; cd ../..; rm -rf a.txt`, "ask"],
  // Attached create options name the new branch too.
  [onFeature, "git switch -cmain && rm a.txt", "ask"],
  [onFeature, "git switch --create=main && rm a.txt", "ask"],
  [onFeature, "git checkout -bmain && rm a.txt", "ask"],
  // A switch that may fail leaves the branch before it in play.
  [onMain, "git checkout feature; rm a.txt", "ask"],
  [onMain, "git switch feature || git merge feature", "deny"],
  // New and tracking branches, and @{-N}, are what they name.
  [onFeature, "git checkout -b main && rm a.txt", "ask"],
  [onFeature, "git checkout --orphan main && rm a.txt", "ask"],
  [onFeature, "git switch --track origin/main && rm a.txt", "ask"],
  [onFeature, "git checkout @{-1} && rm a.txt", "ask"],
];
for (const [cwd, command, expected] of deleteCases) {
  assert.equal(decide(command, { cwd, env: temps }), expected, `${path.basename(cwd)}: ${command}`);
}
// A verified push never covers a delete chained onto it: the push alone is allowed, and with a
// delete in a main checkout the whole command asks.
assert.equal(decide("git push origin feature", { env: temps }), "allow", "the push alone is verified");
assert.equal(decide(`git push origin feature && rm ${path.join(onMain, "a.txt")}`, { env: temps }), "ask", "a chained main delete asks");
assert.equal(decide(`git push origin feature && rm ${path.join(scratch, "x")}`, { env: temps }), "defer", "a chained temp delete drops the allow");
// Temp folders win: with the default temp roots, the system temp folder holding these fixtures is
// temp, so even the checkout on main deletes freely there.
assert.equal(decide("rm a.txt", { cwd: onMain }), "defer", "a checkout under a temp folder is temp");
// Extra protected names count, and Codex, which cannot ask, denies.
gitOk(onFeature, "switch", "-q", "-c", "release");
assert.equal(decide("rm a.txt", { cwd: onFeature, env: { ...temps, ROBOREPO_PROTECTED_BRANCHES: "release" } }), "ask", "extra protected names guard deletes");
gitOk(onFeature, "switch", "-q", "feature");
for (const command of ["rm a.txt", "git reset --hard"]) {
  assert.equal(decide(command, { cwd: onMain, env: temps, toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex denies: ${command}`);
}
const reason = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ cwd: onMain, tool_name: "Bash", tool_input: { command: "rm a.txt" } }),
  encoding: "utf8", env: { ...gitEnv, ...temps },
}).stdout;
assert.match(JSON.parse(reason).hookSpecificOutput.permissionDecisionReason, /protected branch "main"/, "the ask names the branch");

// Outside Claude's sandbox nothing limits a delete to the checkout, so any delete outside the temp
// folders asks; a temp delete still does not.
const unsandboxedDecision = (command, cwd) => {
  const out = spawnSync(process.execPath, [hook], {
    input: JSON.stringify({ cwd, tool_name: "Bash", tool_input: { command, dangerouslyDisableSandbox: true } }),
    encoding: "utf8", env: { ...gitEnv, ...temps },
  }).stdout;
  return out ? JSON.parse(out).hookSpecificOutput.permissionDecision : "defer";
};
assert.equal(unsandboxedDecision(`rm ${path.join(onFeature, "a.txt")}`, onFeature), "ask", "an unsandboxed delete asks");
assert.equal(unsandboxedDecision(`rm ${path.join(scratch, "x")}`, onFeature), "defer", "an unsandboxed temp delete does not");

// Agents never merge into a protected branch: merge, pull, rebase, and cherry-pick are denied in a
// checkout that has one checked out, wherever the command runs from. A fast-forward-only update
// from the branch's own upstream, and stopping one in progress, are not.
const mergeCases = [
  [onMain, "git merge feature", "deny"],
  [onMain, "echo `true #x`; git merge feature", "deny"],
  [onMain, "echo hi # note \\\ngit merge feature", "deny"],
  [onMain, "x=${a:- #}; git merge feature", "deny"],
  [onMain, "git merge --no-ff --no-edit feature", "deny"],
  [onMain, "git merge --ff-only feature", "deny"],
  [onMain, "git merge --continue", "deny"],
  [onMain, "git pull", "deny"],
  [onMain, "git pull --rebase origin main", "deny"],
  [onMain, "git pull --ff-only origin feature", "deny"],
  [onMain, "git rebase feature", "deny"],
  [onMain, "git cherry-pick abc123", "deny"],
  [onMain, "git fetch origin && git merge origin/feature", "deny"],
  [onFeature, `git -C ${onMain} merge feature`, "deny"],
  [onFeature, `cd ${onMain} && git merge feature`, "deny"],
  [onFeature, `(cd ${onMain} && git pull)`, "deny"],
  [onFeature, `sh -c 'cd ${onMain} && git rebase feature'`, "deny"],
  [onMain, "git pull --ff-only", "defer"],
  [onMain, "git pull --ff-only origin", "defer"],
  [onMain, "git pull --ff-only origin main", "defer"],
  [onMain, "git merge --ff-only origin/main", "defer"],
  [onMain, "git merge --ff-only @{u}", "defer"],
  [onMain, "git merge --ff-only main@{u}", "defer"],
  [onMain, "git merge --ff-only -m msg origin/main", "defer"],
  [onMain, "git pull --ff-only -X ours origin main", "defer"],
  [onMain, "git pull --ff-only origin refs/heads/main", "defer"],
  // A fast-forward from anything but the branch's own upstream would land other history.
  [onMain, "git merge --ff-only x/main", "deny"],
  [onMain, "git merge --ff-only refs/heads/x/main", "deny"],
  [onMain, `git pull --ff-only ${onFeature}`, "deny"],
  [onMain, "git pull --ff-only ../otherclone main", "deny"],
  [onMain, "git pull --ff-only https://example.com/other.git main", "deny"],
  [onMain, "git am patch.mbox", "deny"],
  [onMain, "git am --abort", "defer"],
  // git honors the last of --ff-only, --ff, --no-ff; fetch options take values.
  [onMain, "git merge --ff-only origin/main --no-ff", "deny"],
  [onMain, "git pull --ff-only --depth 1 origin main", "defer"],
  // --upload-pack and git -c can fetch from another repository under the remote's name.
  [onMain, "git pull --ff-only --upload-pack 'git-upload-pack /elsewhere' origin main", "deny"],
  [onMain, "git pull --ff-only --upload-pack=x origin main", "deny"],
  [onMain, "git -c remote.origin.url=/elsewhere pull --ff-only origin main", "deny"],
  [onMain, "git merge --abort", "defer"],
  [onMain, "git rebase --abort", "defer"],
  [onMain, "git cherry-pick --quit", "defer"],
  [onFeature, "git merge main", "defer"],
  [onFeature, "git pull origin main", "defer"],
  [onFeature, "git rebase main", "defer"],
  [onFeature, `cd ${onMain} && git merge feature; cd ${onFeature} && git merge main`, "deny"],
];
for (const [cwd, command, expected] of mergeCases) {
  assert.equal(decide(command, { cwd, env: temps }), expected, `${path.basename(cwd)}: ${command}`);
  if (expected === "deny") {
    assert.equal(decide(command, { cwd, env: temps, toolName: "exec_command", hookPath: codexHook, key: "cmd" }), "deny", `Codex: ${command}`);
  }
}
assert.equal(decide("git merge feature", { cwd: onFeature, env: { ...temps, ROBOREPO_PROTECTED_BRANCHES: "feature" } }), "deny", "extra protected names guard merges");
assert.equal(decide("git push origin feature && git merge feature", { cwd: onMain, env: temps }), "deny", "a chained merge into main drops the push allow");
const mergeReason = spawnSync(process.execPath, [hook], {
  input: JSON.stringify({ cwd: onMain, tool_name: "Bash", tool_input: { command: "git merge feature" } }),
  encoding: "utf8", env: { ...gitEnv, ...temps },
}).stdout;
assert.match(JSON.parse(mergeReason).hookSpecificOutput.permissionDecisionReason, /never merge into main.*sync-base/, "the deny names the way forward");

fs.rmSync(tmp, { recursive: true, force: true });
console.log("protected-branch-push-check passed");
