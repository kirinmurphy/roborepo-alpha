import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { privacyHash, PRIVACY_HASH_WIDTH } from "../../cli/telemetry-schemas/hash.mjs";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

// Hashed values are joined across files and across time: capture writes a file_path_hash today, and
// a consumer months later hashes a path it knows and looks for a match. Change the algorithm or the
// width and nothing throws — the joins just return zero rows, which reads exactly like "the session
// touched nothing". These expected values are literals on purpose; deriving them would re-implement
// the thing under test and pass no matter what it became.
export function testPrivacyHashIsPinned() {
  assert.equal(PRIVACY_HASH_WIDTH, 24, "changing the truncation width invalidates every stored hash");
  assert.equal(privacyHash(""), "e3b0c44298fc1c149afbf4c8", "the empty string's hash is a fixed value");
  assert.equal(privacyHash("roborepo"), "7bf53fdcbcb90ea72b356e58");
  assert.equal(privacyHash("npm run test:plans"), "69ff1328de27345a75595590");

  for (const value of ["", "a", "/tmp/x.md", 0, null, undefined]) {
    assert.equal(privacyHash(value).length, PRIVACY_HASH_WIDTH, `every hash is ${PRIVACY_HASH_WIDTH} characters, including for ${String(value)}`);
    assert.match(privacyHash(value), /^[0-9a-f]+$/, "hashes are lowercase hex");
  }
  assert.equal(privacyHash(123), privacyHash("123"), "values are stringified before hashing, so a number and its text form agree");
  assert.notEqual(privacyHash("a"), privacyHash("b"));
}

// The consolidation itself. Five copies of this algorithm were kept aligned by a comment; a sixth
// copy appearing anywhere in the pipeline reintroduces exactly the drift this replaced.
export function testPrivacyHashHasOneImplementation() {
  const pattern = /createHash\(\s*["']sha256["']\s*\)[\s\S]{0,120}?slice\(\s*0\s*,\s*24\s*\)/;
  const searched = [];
  const offenders = [];
  for (const dir of ["scripts/cli", "scripts/cli/telemetry-analysis", "scripts/cli/telemetry-schemas", "modules/telemetry"]) {
    const full = path.join(repoRoot, dir);
    if (!fs.existsSync(full)) continue;
    for (const entry of fs.readdirSync(full)) {
      if (!entry.endsWith(".mjs") || entry === "hash.mjs") continue;
      // The oracle must independently reconstruct raw repository identity; sharing privacyHash
      // would conceal a production hashing regression. Its import boundary and live comparison
      // checks enforce that exception. Every production consumer still uses the shared helper.
      if (dir === "scripts/cli" && entry === "telemetry-oracle-observations.mjs") continue;
      const file = path.join(full, entry);
      if (!fs.statSync(file).isFile()) continue;
      searched.push(path.join(dir, entry));
      if (pattern.test(fs.readFileSync(file, "utf8"))) offenders.push(path.join(dir, entry));
    }
  }
  assert.ok(searched.length > 5, `expected to search the telemetry modules, only saw ${searched.length} files`);
  assert.deepEqual(offenders, [],
    "each file listed here reimplements privacyHash inline; import it from telemetry-schemas/hash.mjs instead — a second copy drifts silently, and a width mismatch empties every cross-file join without failing anything");
}

// telemetry-capture.mjs imports this module and runs on every PreToolUse/PostToolUse hook, so the
// hash module has to stay as cheap to load as the inline copy it replaced.
export function testPrivacyHashModuleStaysDependencyFree() {
  const source = fs.readFileSync(path.join(repoRoot, "scripts/cli/telemetry-schemas/hash.mjs"), "utf8");
  const imports = [...source.matchAll(/^import\s[\s\S]*?from\s+["']([^"']+)["']/gm)].map((match) => match[1]);
  assert.deepEqual(imports, ["node:crypto"],
    "hash.mjs may import node:crypto and nothing else; capture's minimal-import constraint depends on it");
}
