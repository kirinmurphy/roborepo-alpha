import { ORACLE_HEALTH_SCHEMA_VERSION, createOracleHealthResult, emptyOracleHealth,
  isOracleEvidenceSignature, staleOracleHealth } from "./telemetry-schemas/oracle-health-schema.mjs";

const TIMING = Object.freeze({ poll: 2000, quiet: 12000, maximum: 60000, timeout: 30000 });

// Dependencies keep all I/O and worker construction in the portal composition root. Exit, not a
// message or terminate() request, releases the one-worker slot and its temporary evidence heap.
export function createTelemetryOracleObserver({ readSignature, createWorker, now = Date.now, timers = globalThis }) {
  let active = false, stopped = false, interval = null, running = null;
  let lastSignature = null, pendingSince = null, changedAt = 0, health = emptyOracleHealth();

  function pending() { pendingSince ??= now(); changedAt = now(); }
  function observe() {
    let signature;
    try {
      signature = readSignature();
      if (!isOracleEvidenceSignature(signature)) throw new Error("Invalid evidence signature");
    } catch {
      health = emptyOracleHealth("unavailable", "signature_error"); lastSignature = null;
      if (running) running.invalidated = true;
      return null;
    }
    if (signature !== lastSignature) { lastSignature = signature; pending(); }
    health = transitionOracleHealth(health, { type: "observe", signature });
    if (running && running.signature !== signature) running.invalidated = true;
    if (running?.invalidated && !running.error) health = staleOracleHealth(health);
    return signature;
  }

  function requestExit(run, error = null) {
    if (error) { run.error = error; if (active) health = emptyOracleHealth("unavailable", error); }
    if (run.ending) return;
    run.ending = true;
    // A rejected termination is not proof of exit. Keep the slot occupied until the exit event.
    const failed = () => { run.error = "worker_crash"; if (active && running === run) health = emptyOracleHealth("unavailable", run.error); };
    try { Promise.resolve(run.worker.terminate()).catch(failed); } catch { failed(); }
  }

  function exited(run) {
    timers.clearTimeout(run.timeout); run.resolveExit();
    if (running !== run) return;
    running = null;
    if (!active) return;
    const signature = observe();
    if (!signature) { pending(); return; }
    if (run.error || !run.result) health = emptyOracleHealth("unavailable", run.error ?? "worker_crash");
    else {
      health = transitionOracleHealth(health, { type: "finish", signature, result: run.result });
      if (run.invalidated && health.evidence_signature) health = staleOracleHealth(health);
    }
    if (["unavailable", "stale"].includes(health.status) && pendingSince === null) pending();
  }

  function launch(signature) {
    pendingSince = null;
    health = transitionOracleHealth(health, { type: "start", signature });
    let worker;
    try { worker = createWorker(signature); }
    catch { health = emptyOracleHealth("unavailable", "worker_start_error"); pending(); return; }
    const run = { worker, signature, ending: false, invalidated: false, result: null, error: null };
    run.exit = new Promise((resolve) => { run.resolveExit = resolve; }); running = run;
    worker.once("exit", () => exited(run));
    worker.once("error", () => { if (running === run) requestExit(run, "worker_crash"); });
    worker.once("message", (result) => {
      if (run.ending || !active || running !== run) return;
      if (result?.evidence_signature !== signature) { requestExit(run, "invalid_worker_result"); return; }
      run.result = transitionOracleHealth(health, { type: "finish", signature, result });
      requestExit(run);
    });
    run.timeout = timers.setTimeout(() => requestExit(run, "worker_timeout"), TIMING.timeout);
    run.timeout.unref?.();
  }

  function tick(startup = false) {
    if (!active) return;
    const signature = observe();
    if (signature && !running && pendingSince !== null
      && (startup || now() - changedAt >= TIMING.quiet || now() - pendingSince >= TIMING.maximum)) launch(signature);
  }

  return {
    start() {
      if (active || stopped) return;
      active = true; tick(true);
      interval = timers.setInterval(tick, TIMING.poll); interval.unref?.();
    },
    stop() {
      active = false; stopped = true; timers.clearInterval(interval);
      health = emptyOracleHealth("unavailable");
      if (!running) return Promise.resolve();
      timers.clearTimeout(running.timeout); requestExit(running); return running.exit;
    },
    getHealth() { return structuredClone(health); },
  };
}

// Pure status policy. Completion always receives a freshly read current signature.
export function transitionOracleHealth(previous, action) {
  if (action.type === "error") return emptyOracleHealth("unavailable", action.error_category);
  if (!isOracleEvidenceSignature(action.signature)) return emptyOracleHealth("unavailable", "signature_error");
  if (action.type === "finish") {
    if (action.result?.schema !== ORACLE_HEALTH_SCHEMA_VERSION) return emptyOracleHealth("unavailable", "invalid_worker_result");
    const result = createOracleHealthResult(action.result, action.result);
    if (!result.evidence_signature) return result;
    return result.evidence_signature === action.signature ? result : staleOracleHealth(result);
  }
  if (!["observe", "start"].includes(action.type)) throw new Error("Unknown oracle health transition");
  if (previous.evidence_signature && previous.evidence_signature !== action.signature) return staleOracleHealth(previous);
  if (action.type === "start" && (!previous.checked_at || previous.status === "unavailable")) return emptyOracleHealth("checking");
  return previous;
}
