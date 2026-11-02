#!/usr/bin/env node
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "docs-reference-"));
const checker = fileURLToPath(new URL("./docs-reference-check.mjs", import.meta.url));
try {
  write("docs/target.md", "# First\n\n## Repeat\n\n## Repeat\n\n## Step 1 — When they agree\n");
  write("docs/dated.md", "# Dated audit\n\nSnapshot date: 2026-09-13\n\n`scripts/old-file.mjs`\n");
  for (const [markdown, reason] of [
    ["[missing](docs/missing.md)", "missing link target: docs/missing.md"],
    ["[missing with parentheses](docs/missing-(draft).md)", "missing link target: docs/missing-(draft).md"],
    ["![missing image](docs/no-image.png)", "missing link target: docs/no-image.png"],
    ["[bad anchor](docs/target.md#absent)", "missing anchor: docs/target.md#absent"],
    ["[collapsed anchor](docs/target.md#step-1-when-they-agree)", "missing anchor: docs/target.md#step-1-when-they-agree"],
    ["[bad reference][gone]\n\n[gone]: docs/missing-again.md", "missing link target: docs/missing-again.md"],
    ["[undefined reference][gone]", "missing reference definition [gone]"],
    ["See [guide].\n\n[guide]: docs/missing.md", "missing link target: docs/missing.md"],
    ["![image]\n\n[image]: docs/no-image.png", "missing link target: docs/no-image.png"],
    ["See [heading].\n\n[heading]: docs/target.md#absent", "missing anchor: docs/target.md#absent"],
    ["`scripts/no-file.mjs` is the current module.", "missing repository path: scripts/no-file.mjs"],
    ["`scripts/old.mjs` was removed; `scripts/no-file.mjs` is current.", "missing repository path: scripts/no-file.mjs"],
    ["~~~md\n```sh\n~~~\n[missing](docs/after-fence.md)", "missing link target: docs/after-fence.md"],
  ]) {
    write("README.md", `# Fixture\n\n${markdown}\n`);
    const failed = run();
    assert.equal(failed.status, 1, markdown);
    assert.ok(failed.stderr.includes(reason), `${markdown}: ${failed.stderr}`);
    assert.equal(failed.stderr.trim().split("\n").length, 1, failed.stderr);
  }

  write("README.md", [
    "# Clean",
    "[duplicate](docs/target.md#repeat-1)",
    "[GitHub heading](docs/target.md#step-1--when-they-agree)",
    "[query](docs/target.md?mode=read#first)",
    "[external](https://example.com/missing.md)",
    "See [shortcut] and ![picture] and [undefined prose].",
    "[shortcut]: docs/target.md#repeat-1",
    "[picture]: docs/target.md",
    "`[example]` and [inline](docs/target.md) and [full][shortcut]",
    "[example]: docs/missing-example.md",
    "`scripts/<name>.mjs` is a placeholder.",
    "`scripts/removed.mjs` no longer exists.",
    "```sh",
    "roborepo serve",
    "`scripts/in-example.mjs`",
    "```",
    "~~~md",
    "```sh",
    "[example](docs/only-in-fence.md)",
    "~~~",
  ].join("\n"));
  const passed = run();
  assert.equal(passed.status, 0, passed.stderr);
  assert.match(passed.stdout, /docs references check passed/);
  console.log("docs reference fixtures check passed");
} finally {
  fs.rmSync(root, { recursive: true, force: true });
}

function write(relative, contents) {
  const absolute = path.join(root, relative);
  fs.mkdirSync(path.dirname(absolute), { recursive: true });
  fs.writeFileSync(absolute, contents);
}

function run() {
  return spawnSync(process.execPath, [checker, root], { encoding: "utf8" });
}
