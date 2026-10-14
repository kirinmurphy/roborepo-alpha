#!/usr/bin/env node
import path from "node:path";
import { fileURLToPath } from "node:url";
import { scanDocs } from "./docs-reference-scan.mjs";

const repository = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const root = path.resolve(process.argv[2] || repository);
const findings = scanDocs(root);
for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.reason}`);
if (findings.length) process.exitCode = 1;
else console.log("docs references check passed");
