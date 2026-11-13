import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fetchTrackingRefs, updatePullRequest } from "../../modules/delivery/operations.mjs";

const permissionsManifest = new URL("../../manifests/inventory/agent-permissions.json", import.meta.url);

// Converts a `read-secrets` permission pattern (`~/dir/**` or `//**/name`) to a regular
// expression over a forward-slash absolute path. A leading `/` also matches a Windows drive.
function secretPatternRegExp(pattern, home) {
  const absolute = pattern.startsWith("~/") ? `${home}/${pattern.slice(2)}` : pattern.replace(/^\/\//, "/");
  const source = absolute.split(/(\*\*\/|\*\*|\*)/).map((part) => {
    if (part === "**/") return "(?:.*/)?";
    if (part === "**") return ".*";
    if (part === "*") return "[^/]*";
    return part.replace(/[.+?^${}()|[\]\\]/g, "\\$&");
  }).join("");
  const drive = absolute.startsWith("/") ? "(?:[A-Za-z]:)?" : "";
  return new RegExp(`^${drive}${source}$`, process.platform === "linux" ? "" : "i");
}

function isDeniedSecret(resolved) {
  const manifest = JSON.parse(fs.readFileSync(permissionsManifest, "utf8"));
  const patterns = manifest.behaviors.find((behavior) => behavior.id === "read-secrets")?.paths ?? [];
  const slashed = (value) => value.split(path.sep).join("/");
  const homes = [...new Set([os.homedir(), fs.realpathSync(os.homedir())].map(slashed))];
  return patterns.some((pattern) => homes.some((home) => secretPatternRegExp(pattern, home).test(slashed(resolved))));
}

// Agent permissions allow `delivery pr-body` with any argument, and the command reads the file
// outside the agent's Read tool, so it must enforce what Read would: the body must resolve, after
// symlinks, to a regular file inside a temp directory that the `read-secrets` denylist does not
// name. Refusals and read errors never print the path.
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
  if (isDeniedSecret(resolved)) throw new Error("PR body file matches the read-secrets credential denylist (path not printed)");
  let stat;
  let body;
  try {
    stat = fs.statSync(resolved);
    body = stat.isFile() ? fs.readFileSync(resolved, "utf8") : null;
  } catch (error) {
    throw new Error(`PR body file could not be read (${error.code || "unknown error"}; path not printed)`);
  }
  if (!stat.isFile()) throw new Error("PR body file must be a regular file");
  return body;
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
