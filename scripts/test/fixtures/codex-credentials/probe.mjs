import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";

const [root, expectation, writeMode] = process.argv.slice(2);
const fixtures = JSON.parse(fs.readFileSync(path.join(root, "fixtures.json"), "utf8"));
const denied = expectation === "deny";
const canary = "synthetic-credential-canary";
for (const file of fixtures) {
  const target = path.join(root, file);
  if (denied) {
    assert.throws(() => fs.readFileSync(target), { code: /EACCES|EPERM/ }, `credential readable: ${file}`);
    assert.throws(() => fs.writeFileSync(target, "changed"), { code: /EACCES|EPERM/ }, `credential writable: ${file}`);
  } else {
    assert.equal(fs.readFileSync(target, "utf8"), canary);
    fs.writeFileSync(target, canary);
  }
  for (const [command, args, input] of [
    ["/bin/cat", [target]],
    ["/bin/sh", ["-c", 'cat "$1"', "probe", target]],
    ["/usr/bin/xargs", ["-0", "/bin/cat"], `${target}\0`],
    [process.execPath, ["-e", "require('fs').readFileSync(process.argv[1])", target]],
  ]) {
    const result = spawnSync(command, args, { encoding: "utf8", input });
    assert.equal(result.error, undefined);
    assert.equal(result.status === 0, !denied, `command control: ${command} ${file}: ${result.stderr}`);
    if (denied) assert.doesNotMatch(result.stdout, /synthetic-credential-canary/);
    else assert.equal(result.stdout.includes(canary), command !== process.execPath);
  }
}
assert.equal(fs.readFileSync(path.join(root, "public.txt"), "utf8"), "public");
for (const template of [".env.example", ".env.sample", "other.config"]) {
  assert.equal(fs.readFileSync(path.join(root, "workspace", template), "utf8"), "template");
}
const publicWrite = () => fs.writeFileSync(path.join(root, "workspace", "public-write"), "public");
if (writeMode === "read-only") assert.throws(publicWrite, { code: /EACCES|EPERM/ });
else publicWrite();
if (writeMode !== "read-only") {
  fs.mkdirSync(path.join(root, "workspace", "created-after-start"), { recursive: true });
  const newSecret = () => fs.writeFileSync(path.join(root, "workspace", "created-after-start", ".env"), canary);
  if (denied) assert.throws(newSecret, { code: /EACCES|EPERM/ });
  else newSecret();
}
console.log(`credential probe ok (${expectation}, ${writeMode}, ${fixtures.length} files)`);
