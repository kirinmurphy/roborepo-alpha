import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const MAX_COMMAND_BUFFER_BYTES = 1024 * 1024;

// Each provider supplies its own timeout and handles command failures at its discovery boundary.
export async function defaultRunCommand(command, args, { timeoutMs } = {}) {
  return execFileAsync(command, args, {
    timeout: timeoutMs,
    encoding: "utf8",
    maxBuffer: MAX_COMMAND_BUFFER_BYTES,
  });
}
