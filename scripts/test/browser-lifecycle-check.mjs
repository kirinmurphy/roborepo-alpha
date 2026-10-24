#!/usr/bin/env node
// The app a `roborepo browser run` checks against: a service already answering is reused and left
// running; one the run starts with --serve is stopped afterward, including a server the command
// backgrounded and a run interrupted mid-wait; an unreachable or malformed URL is reported, not
// waited on.
//
// Drives the stub provider through the real CLI, so no browser is needed.
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { spawn } from "node:child_process";
import { createBrowserCliHome } from "./lib/browser-cli-home.mjs";
import { freePort, responds, waitFor } from "./lib/local-http.mjs";

const cli = createBrowserCliHome("roborepo-browser-lifecycle-");
const fixtures = path.join(cli.home, "fixtures");
fs.mkdirSync(fixtures);
const passing = path.join(fixtures, "passing.json");
fs.writeFileSync(passing, JSON.stringify({ checks: [{ name: "renders", status: "passed" }] }));
// Serves on argv[2] and, when given, writes its pid to argv[3].
const server = path.join(fixtures, "server.mjs");
fs.writeFileSync(server, [
  'import http from "node:http";',
  'import fs from "node:fs";',
  "if (process.argv[3]) fs.writeFileSync(process.argv[3], String(process.pid));",
  'http.createServer((req, res) => res.end("ok")).listen(Number(process.argv[2]), "127.0.0.1");',
].join("\n"));
const serve = (...args) => `node ${[server, ...args].map((arg) => JSON.stringify(String(arg))).join(" ")}`;
const children = [];

try {
  assert.equal(cli.run(["package", "enable", "feature-verification"]).status, 0);

  const deadPort = await freePort();
  const unavailable = JSON.parse(cli.stub(["--scenario", passing, "--url", `http://127.0.0.1:${deadPort}/`, "--json"]).stdout);
  assert.equal(unavailable.status, "blocked");
  assert.match(unavailable.limitations.join("\n"), /no local service responded/, "an unavailable service is an actionable limitation");

  const noScheme = cli.stub(["--scenario", passing, "--url", `127.0.0.1:${deadPort}`, "--serve", "true"]);
  assert.equal(noScheme.status, 2, "a URL without an http(s) scheme is a usage error, not a timeout");

  const startedPort = await freePort();
  const started = cli.stub(["--scenario", passing, "--url", `http://127.0.0.1:${startedPort}/`, "--serve", serve(startedPort), "--json"]);
  assert.equal(JSON.parse(started.stdout).status, "passed", "the run waits for the service it started");
  assert.equal(await responds(startedPort), false, "a service the run started is gone afterward");

  // A dev command that backgrounds its server exits 0 at once; the server is still the run's to stop.
  const backgroundPort = await freePort();
  const backgrounded = cli.stub(["--scenario", passing, "--url", `http://127.0.0.1:${backgroundPort}/`, "--serve", `${serve(backgroundPort)} &`, "--json"]);
  assert.equal(JSON.parse(backgrounded.stdout).status, "passed", "a backgrounding --serve still serves the run");
  assert.equal(await responds(backgroundPort), false, "a backgrounded server the run started is gone afterward");

  const existingPort = await freePort();
  children.push(spawn(process.execPath, [server, String(existingPort)], { stdio: "ignore" }));
  await waitFor(() => responds(existingPort));
  const marker = path.join(fixtures, "serve-ran");
  cli.stub(["--scenario", passing, "--url", `http://127.0.0.1:${existingPort}/`, "--serve", serve(existingPort, marker)]);
  assert.equal(await responds(existingPort), true, "a service that was already running is still running");
  assert.ok(!fs.existsSync(marker), "--serve is not run when the URL already responds");

  const serveWithoutUrl = JSON.parse(cli.stub(["--scenario", passing, "--serve", "true", "--json"]).stdout);
  assert.equal(serveWithoutUrl.status, "blocked", "--serve without --url cannot tell when the service is ready");

  // Interrupted while waiting: the served process listens on a port the run never polls, so the run
  // is still waiting when the signal arrives.
  const [waitedPort, servedPort] = [await freePort(), await freePort()];
  const pidFile = path.join(fixtures, "interrupted.pid");
  const interrupted = cli.startStub(["--scenario", passing, "--url", `http://127.0.0.1:${waitedPort}/`, "--serve", serve(servedPort, pidFile)]);
  await waitFor(() => responds(servedPort));
  interrupted.child.kill("SIGTERM");
  assert.equal((await interrupted.done).status, 143, "an interrupted run exits with the signal's code");
  await waitFor(async () => !(await responds(servedPort)));
  assert.equal(isAlive(Number(fs.readFileSync(pidFile, "utf8"))), false, "a service started by an interrupted run is stopped");

  if (process.platform !== "win32") {
    const stubbornPort = await freePort();
    const stubbornPid = path.join(fixtures, "stubborn.pid");
    const stubborn = path.join(fixtures, "stubborn.mjs");
    fs.writeFileSync(stubborn, `process.on("SIGTERM", () => {});\nawait import(${JSON.stringify(server)});\n`);
    try {
      const result = cli.stub(["--scenario", passing, "--url", `http://127.0.0.1:${stubbornPort}/`, "--serve",
        `node ${[stubborn, stubbornPort, stubbornPid].map((arg) => JSON.stringify(String(arg))).join(" ")}`, "--json"]);
      assert.equal(JSON.parse(result.stdout).status, "passed");
      assert.equal(await responds(stubbornPort), false, "cleanup stops a service that ignores SIGTERM before returning");
    } finally {
      if (fs.existsSync(stubbornPid)) {
        try { process.kill(Number(fs.readFileSync(stubbornPid, "utf8")), "SIGKILL"); } catch {}
      }
    }
  }

  console.log("ok: browser service lifecycle (reuse, start/stop, background, interrupt, bad URL, forced shutdown)");
} finally {
  for (const child of children) child.kill();
  cli.cleanup();
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}
