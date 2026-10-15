// POSIX shell quoting for commands RoboRepo shows a user to copy, such as a harness's MCP add line or
// the command that opens Codex's hook review. Leaves plain words bare so common commands stay legible.

export function shellQuote(arg) {
  if (/^[a-zA-Z0-9_./:=@%+-]+$/.test(arg)) return arg;
  return `'${arg.replace(/'/g, `'\\''`)}'`;
}
