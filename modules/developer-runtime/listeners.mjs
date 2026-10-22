import { defaultRunCommand } from "./command-exec.mjs";
import { parseCwdFieldOutput, parseLsofFieldOutput } from "./lsof.mjs";

export { defaultRunCommand };

export const LISTENER_DISCOVERY_TIMEOUT_MS = 3000;

export async function discoverListenerRecords({
  platform = process.platform,
  runCommand = defaultRunCommand,
  timeoutMs = LISTENER_DISCOVERY_TIMEOUT_MS,
} = {}) {
  const warnings = [];
  if (platform !== "darwin") return { warnings, records: [] };

  let listenerOutput;
  try {
    listenerOutput = await runCommand("lsof", ["-nP", "-iTCP", "-sTCP:LISTEN", "-F", "pcn"], { timeoutMs });
  } catch (err) {
    return { warnings: [`listener discovery failed: ${err.message}`], records: [] };
  }

  const cwdByPid = new Map();
  const records = [];
  for (const listener of parseLsofFieldOutput(listenerOutput.stdout ?? listenerOutput)) {
    if (!cwdByPid.has(listener.pid)) {
      cwdByPid.set(listener.pid, await resolvePidCwd(listener.pid, runCommand, timeoutMs, warnings));
    }
    records.push({ listener, cwd: cwdByPid.get(listener.pid) });
  }
  return { warnings, records };
}

// Exported for stop.mjs, which re-reads a PID's working directory immediately before signalling it.
export async function resolvePidCwd(pid, runCommand, timeoutMs, warnings) {
  try {
    const result = await runCommand("lsof", ["-a", "-p", String(pid), "-d", "cwd", "-F", "n"], { timeoutMs });
    return parseCwdFieldOutput(result.stdout ?? result);
  } catch (err) {
    warnings.push(`cwd lookup failed for pid ${pid}: ${err.message}`);
    return null;
  }
}
