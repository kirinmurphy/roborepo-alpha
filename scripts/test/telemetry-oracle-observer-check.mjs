import assert from "node:assert/strict";
import { observerFixture, signatures, healthResult } from "./fixtures/telemetry-oracle-observer.mjs";

const [a, b, c] = signatures;
for (const status of ["passed", "partial", "failed", "unavailable"]) {
  const f = observerFixture();
  assert.equal(f.observer.getHealth().status, "checking");
  f.observer.start(); f.observer.start();
  assert.equal(f.workers.length, 1, "startup is immediate and idempotent");
  f.finish(status);
  assert.equal(f.observer.getHealth().status, status);
  const copy = f.observer.getHealth(); copy.coverage.checks.length = 0;
  assert.equal(f.observer.getHealth().coverage.checks.length, 7, "consumers cannot mutate cached health");
  const reads = f.state.reads;
  f.observer.getHealth(); assert.equal(f.state.reads, reads, "cache reads perform no signature I/O");
  f.advance(60_000);
  assert.equal(f.workers.length, status === "unavailable" ? 3 : 1, "only unavailable results retry on unchanged evidence");
  const stopped = f.observer.stop(); f.advance(0); await stopped;
  assert.equal(f.scheduled.size, 0);
}

{
  const f = observerFixture(); f.observer.start(); f.finish();
  f.state.signature = b; f.advance(2000);
  assert.equal(f.observer.getHealth().status, "stale");
  f.advance(11_999); assert.equal(f.workers.length, 1);
  f.advance(1); assert.equal(f.workers.length, 2, "12 seconds of quiet starts the newest evidence");
  assert.equal(f.workers[1].signature, b); f.finish();
  assert.equal(f.observer.getHealth().status, "passed");
  await f.observer.stop();
}
{
  const f = observerFixture(); f.observer.start(); f.finish();
  for (let tick = 1; tick <= 31; tick++) { f.state.signature = `sha256:${tick.toString(16).padStart(64, "0")}`; f.advance(2000); }
  assert.equal(f.workers.length, 2, "continuous changes cannot defer a run past 60 seconds");
  assert.equal(f.workers[1].signature, f.state.signature);
  const stopped = f.observer.stop(); f.advance(0); await stopped;
}
{
  const f = observerFixture(); f.observer.start(); f.state.signature = b; f.advance(2000);
  f.state.signature = c; f.advance(2000); f.finish();
  assert.equal(f.observer.getHealth().status, "stale", "changed evidence rejects the finished pass");
  f.advance(12_000); assert.equal(f.workers.length, 2);
  assert.equal(f.workers[1].signature, c, "intermediate signatures never become queued workers");
  f.finish(); assert.equal(f.observer.getHealth().evidence_signature, c);
  await f.observer.stop();
}
{
  const f = observerFixture(); f.observer.start(); f.state.signature = b;
  f.finish(); assert.equal(f.observer.getHealth().status, "stale", "completion re-reads even between polling ticks");
  await f.observer.stop();
}
{
  const f = observerFixture(); f.observer.start(); f.state.signature = b; f.advance(2000);
  f.state.signature = a; f.advance(2000); f.finish();
  assert.equal(f.observer.getHealth().status, "stale", "observed changes invalidate even a reverted signature");
  await f.observer.stop();
}
for (const failure of ["worker_timeout", "worker_crash", "worker_start_error", "invalid_worker_result"]) {
  const f = observerFixture(); f.state.startError = failure === "worker_start_error"; f.observer.start();
  if (failure === "worker_timeout") { f.advance(29_999); assert.equal(f.observer.getHealth().status, "checking"); f.advance(1); }
  if (failure === "worker_crash") { f.workers[0].emit("error", new Error("PRIVATE-ERROR")); f.advance(0); }
  if (failure === "invalid_worker_result") { f.workers[0].emit("message", { secret: "PRIVATE-RESULT" }); f.advance(0); }
  assert.equal(f.observer.getHealth().status, "unavailable");
  assert.equal(f.observer.getHealth().error_category, failure);
  assert.doesNotMatch(JSON.stringify(f.observer.getHealth()), /PRIVATE/);
  f.state.startError = false; const before = f.workers.length; f.advance(12_000);
  assert.equal(f.workers.length, before + 1, "operational failures retry without new evidence");
  f.finish(); assert.equal(f.observer.getHealth().status, "passed"); await f.observer.stop();
}
{
  const f = observerFixture(); f.observer.start(); f.workers[0].exit();
  assert.equal(f.observer.getHealth().error_category, "worker_crash", "exit without a result is unavailable");
  await f.observer.stop();
}
{
  const f = observerFixture(); f.observer.start(); f.state.signature = b;
  f.finish("passed", b);
  assert.equal(f.observer.getHealth().error_category, "invalid_worker_result", "worker cannot relabel its assigned snapshot");
  await f.observer.stop();
}
{
  const f = observerFixture(); f.state.signatureError = true; f.observer.start();
  assert.equal(f.workers.length, 0); assert.equal(f.observer.getHealth().error_category, "signature_error");
  f.state.signatureError = false; f.advance(14_000); assert.equal(f.workers.length, 1);
  f.state.signatureError = true; f.finish(); assert.equal(f.observer.getHealth().error_category, "signature_error");
  await f.observer.stop();
}
{
  const f = observerFixture(); f.state.delayExit = true; f.observer.start();
  f.workers[0].emit("message", healthResult()); f.state.signature = b; f.advance(60_000);
  assert.equal(f.workers.length, 1, "termination must finish before another worker starts");
  assert.equal(f.observer.getHealth().status, "unavailable", "evidence changes cannot hide a timeout");
  assert.equal(f.observer.getHealth().error_category, "worker_timeout");
  assert.equal(f.workers[0].terminations, 1);
  let stopped = false; const done = f.observer.stop().then(() => { stopped = true; });
  await Promise.resolve(); assert.equal(stopped, false, "shutdown awaits the worker's exit");
  f.workers[0].exit(); await done;
  const status = f.observer.getHealth();
  f.workers[0].emit("message", healthResult()); f.advance(120_000); f.observer.start();
  assert.deepEqual(f.observer.getHealth(), status, "shutdown rejects late outcomes and cannot restart");
  assert.equal(f.workers.length, 1); assert.equal(f.scheduled.size, 0);
}
{
  const f = observerFixture(); f.observer.start();
  f.workers[0].terminate = () => Promise.reject(new Error("PRIVATE-TERMINATION"));
  f.workers[0].emit("message", healthResult()); await Promise.resolve(); f.advance(60_000);
  assert.equal(f.workers.length, 1, "a rejected terminate request cannot release the worker slot");
  assert.equal(f.observer.getHealth().status, "unavailable");
  f.workers[0].exit(); f.advance(12_000); assert.equal(f.workers.length, 2);
  f.finish(); f.workers[0].emit("error", new Error("PRIVATE-LATE-ERROR"));
  assert.equal(f.observer.getHealth().status, "passed", "late events from a former worker cannot replace current health");
  await f.observer.stop();
}
console.log("telemetry oracle observer scheduling and lifecycle checks passed");
