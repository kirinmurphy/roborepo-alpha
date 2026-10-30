#!/usr/bin/env node
// Prints the path of a new isolated app root carrying the fixture packages, for shell suites. The
// caller owns the directory and removes it.
import { makeAppRoot } from "./app-root-fixture.mjs";

process.stdout.write(`${makeAppRoot({ prefix: "roborepo-fixture-app-", fixturePackages: true, includeGenerated: true })}\n`);
