import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchTrackingRefs, updatePullRequest } from "../../modules/delivery/operations.mjs";

// Agent permissions allow `delivery pr-body` with any argument, so an unrestricted path could
// publish a secret such as an SSH key or .env file into the PR body. The body must resolve,
// after symlinks, to a regular file inside a temp directory. Refusals never print the path.
function readBodyFile(file) {
  const temporaryRoots = [os.tmpdir(), "/tmp"]
    .filter((root) => fs.existsSync(root))
    .map((root) => fs.realpathSync(root));
  let resolved;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    throw new Error("PR body file was not found (path not printed)");
  }
  if (!temporaryRoots.some((root) => resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) {
    throw new Error(`PR body file must be inside a temp directory (${temporaryRoots.join(" or ")})`);
  }
  if (!fs.statSync(resolved).isFile()) throw new Error("PR body file must be a regular file");
  return fs.readFileSync(resolved, "utf8");
}

export async function deliveryCommand(argv) {
  const [operation, value, ...extra] = argv;
  try {
    const valid = extra.length === 0 && (
      (operation === "fetch" && typeof value === "string")
      || (operation === "pr-body" && typeof value === "string")
      || (operation === "pr-ready" && value === undefined)
      || (operation === "retry-ci" && /^[1-9][0-9]*$/.test(value || "") && Number.isSafeInteger(Number(value)))
    );
    if (!valid) throw new Error("Usage: roborepo delivery fetch <remote> | pr-body <body-file> | pr-ready | retry-ci <run-id>");
    const body = operation === "pr-body" ? readBodyFile(value) : value;
    const message = operation === "fetch"
      ? await fetchTrackingRefs(process.cwd(), value)
      : await updatePullRequest(process.cwd(), operation, body);
    console.log(message);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
