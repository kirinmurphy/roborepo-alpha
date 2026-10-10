import { EventEmitter } from "node:events";
import { createTelemetryOracleObserver } from "../../cli/telemetry-oracle-observer.mjs";
import { createOracleHealthResult } from "../../cli/telemetry-schemas/oracle-health-schema.mjs";

export const signatures = ["a", "b", "c"].map((letter) => `sha256:${letter.repeat(64)}`);

export function healthResult(signature = signatures[0], status = "passed") {
  return createOracleHealthResult({ status, event_count: 1, session_count: 1, operation_count: 1,
    coverage: { supported_events: 1, unsupported_events: 0, comparable: true, complete: status !== "partial",
      issues: status === "partial" ? [{ category: "skipped_evidence", count: 1 }] : [],
      checks: ["sessions", "operations", "conditions", "boundaries", "gating", "regression", "loops"] },
    differences: status === "failed" ? ["conditions"] : [] },
  { evidence_signature: signature, checked_at: "2026-10-01T18:22:31.000Z", duration_ms: 100 });
}

export function observerFixture() {
  let time = 0, nextId = 0;
  const scheduled = new Map(), workers = [];
  const state = { signature: signatures[0], signatureError: false, startError: false, delayExit: false, reads: 0 };
  function schedule(callback, delay, repeat = false) {
    const id = ++nextId; scheduled.set(id, { callback, at: time + delay, repeat, delay }); return id;
  }
  const timers = { setTimeout: (fn, delay) => schedule(fn, delay), clearTimeout: (id) => scheduled.delete(id),
    setInterval: (fn, delay) => schedule(fn, delay, true), clearInterval: (id) => scheduled.delete(id) };
  function advance(ms) {
    const end = time + ms;
    while (true) {
      const entry = [...scheduled].filter(([, job]) => job.at <= end).sort((a, b) => a[1].at - b[1].at || a[0] - b[0])[0];
      if (!entry) break;
      const [id, job] = entry; time = job.at;
      if (job.repeat) job.at += job.delay; else scheduled.delete(id);
      job.callback();
    }
    time = end;
  }
  const observer = createTelemetryOracleObserver({ now: () => time, timers,
    readSignature() { state.reads++; if (state.signatureError) throw new Error("PRIVATE-SIGNATURE"); return state.signature; },
    createWorker(signature) {
      if (state.startError) throw new Error("PRIVATE-WORKER");
      const worker = new EventEmitter(); worker.signature = signature; worker.terminations = 0; worker.exited = false;
      worker.exit = () => { worker.exited = true; worker.emit("exit", 0); };
      worker.terminate = () => { worker.terminations++; if (!state.delayExit) schedule(worker.exit, 0); return Promise.resolve(0); };
      workers.push(worker); return worker;
    },
  });
  return { observer, state, workers, advance, scheduled,
    finish(status = "passed", signature = workers.at(-1).signature) {
      workers.at(-1).emit("message", healthResult(signature, status)); advance(0);
    } };
}
