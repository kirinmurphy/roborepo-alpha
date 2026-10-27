#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { detectHarnessProvider, selectedHarnessExecutable } from "../harnesses/discovery.mjs";
import { findDeepReadProvider, runDeepRead } from "../cli/telemetry.mjs";
import { codexHookGuidance } from "../harnesses/codex/hook-guidance.mjs";

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const claude = JSON.parse(fs.readFileSync(path.join(repo, "globals/harnesses/claude/provider.json"), "utf8"));
const codex = JSON.parse(fs.readFileSync(path.join(repo, "globals/harnesses/codex/provider.json"), "utf8"));
const fixture = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-desktop-runtime-"));
const oldHome = process.env.HOME;
const oldPath = process.env.PATH;
const home = path.join(fixture, "home");
const bin = path.join(fixture, "bin");
const claudeRoot = path.join(fixture, "claude-code");
const appRoot = path.join(fixture, "Applications");
const roots = {
  "~/Library/Application Support/Claude/claude-code": claudeRoot,
  "/Applications": appRoot,
  "~/Applications": path.join(fixture, "user-apps"),
};
const options = { platform: "darwin", desktopRootPath: (root) => roots[root] };

try {
  fs.mkdirSync(home, { recursive: true });
  fs.mkdirSync(bin, { recursive: true });
  process.env.HOME = home;
  process.env.PATH = bin;
  executable(path.join(bin, "which"), 'if [ -x "$TEST_BIN/$1" ]; then printf "%s\\n" "$TEST_BIN/$1"; fi\n');
  process.env.TEST_BIN = bin;

  assert.equal(detectHarnessProvider(claude, options).confidence, "absent");
  executable(path.join(bin, "claude"), 'echo "1.0.0 (Claude Code)"\n');
  assert.equal(detectHarnessProvider(claude, options).confidence, "probable");
  assert.match(detectHarnessProvider(claude, options).warnings.join(" "), /Launch Claude Code once/);
  fs.unlinkSync(path.join(bin, "claude"));

  const oldBundle = app(path.join(claudeRoot, "2.1.293", "build-a", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", "2.1.293");
  fs.writeFileSync(path.join(path.dirname(oldBundle), ".verified"), "ok");
  const olderNested = app(path.join(claudeRoot, "2.1.292", "build-b", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", "2.1.292");
  fs.writeFileSync(path.join(path.dirname(olderNested), ".verified"), "ok");
  assert.equal(detectHarnessProvider(claude, options).confidence, "probable");
  fs.mkdirSync(path.join(home, ".claude"));
  assert.equal(detectHarnessProvider(claude, options).confidence, "confirmed");
  const flatBundle = app(path.join(claudeRoot, "2.1.295", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", "2.1.295");
  fs.writeFileSync(path.join(path.dirname(flatBundle), ".verified"), "ok");
  const olderFlat = app(path.join(claudeRoot, "2.1.294", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", "2.1.294");
  fs.writeFileSync(path.join(path.dirname(olderFlat), ".verified"), "ok");
  assert.equal(detectHarnessProvider(claude, options).evidence.find((item) => item.source === "desktop")?.version, "2.1.295");
  assert.equal(selectedHarnessExecutable(claude, options), path.join(flatBundle, "Contents/MacOS/claude"));

  executable(path.join(bin, "claude"), 'echo "1.0.0 (Claude Code)"\n');
  const both = detectHarnessProvider(claude, options);
  assert.deepEqual(new Set(both.evidence.filter((item) => item.kind === "executable").map((item) => item.source)), new Set(["cli", "desktop"]));
  assert.equal(both.evidence.find((item) => item.source === "cli")?.version, "1.0.0 (Claude Code)");
  assert.equal(both.evidence.find((item) => item.source === "desktop")?.version, "2.1.295");
  assert.equal(selectedHarnessExecutable(claude, options), path.join(bin, "claude"));
  fs.unlinkSync(path.join(bin, "claude"));

  const config = path.join(home, ".claude", "settings.json");
  fs.writeFileSync(config, "{}\n");
  const before = fs.readFileSync(config);
  const appBefore = fs.readFileSync(path.join(flatBundle, "Contents/MacOS/claude"));
  detectHarnessProvider(claude, options);
  assert.deepEqual(fs.readFileSync(config), before);
  assert.deepEqual(fs.readFileSync(path.join(flatBundle, "Contents/MacOS/claude")), appBefore);
  assert.equal(detectHarnessProvider(claude, { ...options, platform: "linux", desktopRootPath: () => { throw Error("desktop scanned on linux"); } }).confidence, "possible");

  fs.rmSync(claudeRoot, { recursive: true });
  assert.equal(detectHarnessProvider(claude, options).confidence, "possible");
  fs.rmSync(path.join(home, ".claude"), { recursive: true });
  app(path.join(appRoot, "Claude.app"), "com.anthropic.claudefordesktop");
  assert.match(detectHarnessProvider(claude, options).warnings.join(" "), /Code tab/);

  // The no-runtime warning's product copy comes from the manifest's parentApp.setupHint; without
  // one, discovery falls back to a sentence that names no product detail. Either way it keeps the
  // ", then run roborepo harness refresh." ending the portal rewrites (harness-warning.js).
  {
    const withHint = structuredClone(claude);
    const candidate = withHint.platforms.darwin.detection.desktopCandidates[0];
    candidate.parentApp.setupHint = "Open the fixture app's Setup pane to install Claude Code";
    assert.deepEqual(detectHarnessProvider(withHint, options).warnings,
      ["Open the fixture app's Setup pane to install Claude Code, then run roborepo harness refresh."]);
    delete candidate.parentApp.setupHint;
    assert.deepEqual(detectHarnessProvider(withHint, options).warnings,
      ["Open Claude Desktop to install Claude Code, then run roborepo harness refresh."]);
  }

  const wrong = app(path.join(claudeRoot, "2.1.300", "claude.app"), "wrong.id", "Contents/MacOS/claude", "2.1.300");
  fs.writeFileSync(path.join(path.dirname(wrong), ".verified"), "ok");
  assert.equal(detectHarnessProvider(claude, options).confidence, "absent");
  assert.match(detectHarnessProvider(claude, options).warnings.join(" "), /identity/);
  fs.rmSync(claudeRoot, { recursive: true });
  const broken = app(path.join(claudeRoot, "2.1.301", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", null);
  fs.writeFileSync(path.join(path.dirname(broken), ".verified"), "ok");
  assert.match(detectHarnessProvider(claude, options).warnings.join(" "), /version check/);
  assert.equal(detectHarnessProvider(claude, options).confidence, "absent");
  fs.rmSync(claudeRoot, { recursive: true });
  const moved = app(path.join(fixture, "outside", "claude.app"), "com.anthropic.claude-code", "Contents/MacOS/claude", "9.0");
  fs.writeFileSync(path.join(path.dirname(moved), ".verified"), "ok");
  assert.equal(detectHarnessProvider(claude, options).confidence, "absent");

  const codexBundle = app(path.join(appRoot, "ChatGPT.app"), "com.openai.codex", "Contents/Resources/codex", "0.155.0");
  assert.equal(detectHarnessProvider(codex, options).confidence, "probable");
  fs.mkdirSync(path.join(home, ".codex"));
  assert.equal(detectHarnessProvider(codex, options).confidence, "confirmed");
  assert.equal(selectedHarnessExecutable(codex, options), path.join(codexBundle, "Contents/Resources/codex"));
  const desktopGuidance = codexHookGuidance(detectHarnessProvider(codex, options).evidence);
  assert.equal(desktopGuidance.preferredInterface, "desktop");
  assert.equal(desktopGuidance.reviewOnStartup, false);
  assert.equal(desktopGuidance.reviewResolved, "These updates will be applied to your next ChatGPT/Codex session.");
  assert.match(desktopGuidance.reviewApp, /hook review notice.*Settings/);
  assert.match(desktopGuidance.missingCore.steps[1], /In the ChatGPT desktop app/);
  assert.equal(desktopGuidance.review.executable, path.join(codexBundle, "Contents/Resources/codex"));
  executable(path.join(bin, "codex"), 'echo "0.140.0"\n');
  const codexBoth = detectHarnessProvider(codex, options);
  assert.deepEqual(new Set(codexBoth.evidence.filter((item) => item.kind === "executable").map((item) => item.source)), new Set(["cli", "desktop"]));
  assert.equal(codexBoth.evidence.find((item) => item.source === "cli")?.version, "0.140.0");
  assert.equal(codexBoth.evidence.find((item) => item.source === "desktop")?.version, "0.155.0");
  assert.equal(selectedHarnessExecutable(codex, options), path.join(bin, "codex"));
  // Opening Codex for hook review prefers the binary bundled with the desktop app.
  assert.equal(selectedHarnessExecutable(codex, { ...options, prefer: "desktop" }), path.join(codexBundle, "Contents/Resources/codex"));
  assert.equal(codexHookGuidance(codexBoth.evidence).preferredInterface, "desktop", "both interfaces available still prioritizes desktop");

  // Current desktop releases nest the CLI inside its own app; no PATH CLI is needed.
  fs.unlinkSync(path.join(bin, "codex"));
  fs.unlinkSync(path.join(codexBundle, "Contents/Resources/codex"));
  const nestedExecutable = "Contents/Resources/codex-cli/CodexCLI.app/Contents/MacOS/codex";
  app(codexBundle, "com.openai.codex", nestedExecutable, "0.162.0");
  assert.equal(selectedHarnessExecutable(codex, options), path.join(codexBundle, nestedExecutable));
  assert.deepEqual(detectHarnessProvider(codex, options).warnings, [], "an absent alternative layout is not a broken runtime");
  const desktopPath = path.join(codexBundle, nestedExecutable);
  const runtime = { enabledProviders: () => [{ manifest: codex }] };
  const selection = { runtime, resolveExecutable: (manifest) => selectedHarnessExecutable(manifest, options) };
  const argvScript = `#!${process.execPath}\nif (process.argv.includes("--version")) console.log("0.162.0"); else console.log(JSON.stringify(process.argv.slice(2)));\n`;
  fs.writeFileSync(desktopPath, argvScript);
  assert.equal(findDeepReadProvider(selection).executable, desktopPath);
  let synthesis = runDeepRead({ capture_count: 0 }, selection);
  assert.equal(synthesis.ok, true);
  assert.equal(synthesis.cli, "codex");
  assert.deepEqual(JSON.parse(synthesis.text).slice(0, 3), ["exec", "--skip-git-repo-check", "--"]);
  fs.writeFileSync(path.join(bin, "codex"), argvScript, { mode: 0o755 });
  assert.equal(findDeepReadProvider(selection).executable, path.join(bin, "codex"));
  synthesis = runDeepRead({ capture_count: 0 }, selection);
  assert.equal(synthesis.ok, true);
  assert.equal(JSON.parse(synthesis.text).length, 4);
  fs.rmSync(codexBundle, { recursive: true });
  executable(path.join(bin, "codex"), 'echo "0.162.0"\n');
  const cliGuidance = codexHookGuidance(detectHarnessProvider(codex, options).evidence);
  assert.equal(cliGuidance.preferredInterface, "cli");
  assert.equal(cliGuidance.reviewOnStartup, true);
  assert.equal(codexHookGuidance(codexBoth.evidence).reviewOnStartup, false);
  assert.equal(codexHookGuidance().reviewOnStartup, false, "missing runtimes retain unknown-status remedies");
  assert.equal(cliGuidance.reviewApp, null, "CLI-only installations never get desktop instructions");
  assert.match(cliGuidance.missingCore.steps[1], /Codex CLI/);
  assert.match(cliGuidance.inactive, /Codex CLI/);
  assert.equal(cliGuidance.review.executable, path.join(bin, "codex"));
  assert.equal(codexHookGuidance().review, null, "an absent runtime has no CLI fallback to offer");
  console.log("desktop runtime discovery checks passed");
} finally {
  process.env.HOME = oldHome;
  process.env.PATH = oldPath;
  delete process.env.TEST_BIN;
  fs.rmSync(fixture, { recursive: true, force: true });
}

function app(bundle, id, executablePath, version) {
  fs.mkdirSync(path.join(bundle, "Contents"), { recursive: true });
  fs.writeFileSync(path.join(bundle, "Contents/Info.plist"), `<?xml version="1.0"?><plist><dict><key>CFBundleIdentifier</key><string>${id}</string></dict></plist>`);
  if (executablePath) executable(path.join(bundle, executablePath), version ? `echo "${version}"\n` : "exit 1\n");
  return bundle;
}

function executable(file, body) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `#!/bin/sh\n${body}`);
  fs.chmodSync(file, 0o755);
}
