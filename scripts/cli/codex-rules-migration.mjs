#!/usr/bin/env node
// Moves RoboRepo's Codex command rules out of `~/.codex/rules/default.rules`.
//
// RoboRepo now installs its rules as `rules/roborepo.rules`, a file only RoboRepo writes. Codex
// loads every `*.rules` file in that directory and the most restrictive decision wins, so the
// rules apply no matter what `default.rules` holds. `default.rules` belongs to Codex and the user:
// Codex appends "always allow" approvals there. Earlier installs copied RoboRepo's rules into
// `default.rules`, so this strips every line that also appears in RoboRepo's rules file and keeps
// the rest (the user's own approvals). The original is backed up before it is changed.
//
// Usage: codex-rules-migration.mjs <codex-home> <roborepo-rules-source> [--dry-run]
import fs from "node:fs";
import path from "node:path";
import { stateRoot } from "./paths.mjs";
import { isMainModule } from "./roots.mjs";

export function planDefaultRulesMigration(defaultRulesText, roborepoRulesText) {
  const owned = new Set(roborepoRulesText.split("\n").map((line) => line.trim()).filter(Boolean));
  const lines = defaultRulesText.split("\n");
  const kept = lines.filter((line) => !owned.has(line.trim()));
  const removed = lines.length - kept.length;
  if (removed === 0) return { removed: 0, text: defaultRulesText };
  const text = kept.some((line) => line.trim()) ? `${kept.join("\n").replace(/\n+$/, "")}\n` : "";
  return { removed, text };
}

export function migrateCodexDefaultRules({ codexHome, sourcePath, dryRun = false, backupRoot, log = console.log }) {
  const target = path.join(codexHome, "rules", "default.rules");
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch {
    return { changed: false };
  }
  // A symlink would point at someone else's file (an old link into a checkout, or a dotfiles repo):
  // leave it alone rather than rewrite the file behind it.
  if (!stat.isFile()) return { changed: false };

  const current = fs.readFileSync(target, "utf8");
  const plan = planDefaultRulesMigration(current, fs.readFileSync(sourcePath, "utf8"));
  if (plan.removed === 0) return { changed: false };

  const stamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..*$/, "");
  const backup = path.join(backupRoot ?? path.join(stateRoot, "backups", "codex-rules"), `default.rules.${stamp}`);
  const summary = `${plan.removed} RoboRepo rule line(s) from ${target} (now in roborepo.rules)`;
  if (dryRun) {
    log(`would remove ${summary}; backup -> ${backup}`);
    return { changed: true, backup, removed: plan.removed };
  }
  fs.mkdirSync(path.dirname(backup), { recursive: true });
  fs.copyFileSync(target, backup);
  fs.writeFileSync(target, plan.text);
  log(`removed ${summary}; backup -> ${backup}`);
  return { changed: true, backup, removed: plan.removed };
}

if (isMainModule(import.meta.url)) {
  const args = process.argv.slice(2);
  const dryRun = args.includes("--dry-run");
  const [codexHome, sourcePath] = args.filter((arg) => arg !== "--dry-run");
  if (!codexHome || !sourcePath) {
    console.error("usage: codex-rules-migration.mjs <codex-home> <roborepo-rules-source> [--dry-run]");
    process.exit(2);
  }
  migrateCodexDefaultRules({ codexHome, sourcePath, dryRun });
}
