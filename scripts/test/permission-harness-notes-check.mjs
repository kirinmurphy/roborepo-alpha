#!/usr/bin/env node
// Permission rows that only one harness renders say so, in every surface that lists them: the row
// data, the `roborepo config status` printout, and the onboarding wizard. The portal row is covered
// by scripts/test/portal-ui/portal-ui.spec.mjs. Runs against a throwaway home.
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "roborepo-harness-notes-"));
fs.mkdirSync(path.join(home, ".claude"), { recursive: true });
fs.writeFileSync(path.join(home, ".claude", "settings.json"), "{}");
process.env.HOME = home;
process.env.ROBOREPO_STATE_ROOT = path.join(home, ".roborepo");
process.env.ROBOREPO_WORKSPACE_ROOT = path.join(home, "workspace");
process.env.SKIP_MCP = "1";

const NOTES = {
  "sandbox-shell": "Claude",
  "reach-allowed-hosts": "Claude",
  "go-online": "Codex",
  "delete-files": null,
};

try {
  const { buildBehaviorView, readConfigSnapshot } = await import("../cli/config.mjs");
  const { printConfigStatus } = await import("../cli/config-cli-print.mjs");
  const { buildOnboardSteps } = await import("../cli/presets.mjs");

  const view = buildBehaviorView(readConfigSnapshot());
  const permissions = view.find((section) => section.kind === "permissions");
  const rows = new Map(permissions.items.map((item) => [item.id, item]));
  for (const [id, harness] of Object.entries(NOTES)) {
    const row = rows.get(id);
    assert.ok(row, `${id} is a permission row`);
    assert.equal(row.claudeOnly, harness === "Claude", `${id} claudeOnly`);
    assert.equal(row.codexOnly, harness === "Codex", `${id} codexOnly`);
  }

  // The printout lists customized rows only, so present these rows as customized.
  const printed = [];
  const log = console.log;
  console.log = (line = "") => printed.push(String(line));
  try {
    const items = permissions.items.filter((item) => item.id in NOTES).map((item) => ({ ...item, overridden: true, defaultBucket: item.bucket }));
    printConfigStatus([{ ...permissions, items }]);
  } finally {
    console.log = log;
  }
  for (const [id, harness] of Object.entries(NOTES)) {
    const line = printed.find((text) => text.trim().startsWith(`${rows.get(id).bucket} `) && text.includes(` ${rows.get(id).label}`));
    assert.ok(line, `${id} printed`);
    assert.equal(/\[(Claude|Codex) only\]/.exec(line)?.[1] ?? null, harness, `${id} printed note: ${line}`);
  }

  const wizardRows = buildOnboardSteps().flatMap((step) => step.items ?? []);
  for (const [id, harness] of Object.entries(NOTES)) {
    const row = wizardRows.find((item) => item.label === rows.get(id).label);
    assert.ok(row, `${id} is an onboarding row`);
    assert.equal(/\((Claude|Codex) only\)$/.exec(row.description)?.[1] ?? null, harness, `${id} onboarding note`);
  }
  console.log("permission-harness-notes: ok");
} finally {
  fs.rmSync(home, { recursive: true, force: true });
}
