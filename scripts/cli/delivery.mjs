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
  // `os.homedir()` follows $HOME; the account's own home is checked too, so an overridden $HOME
  // cannot move `~/.ssh/**` away from the real one.
  const homes = [...new Set([os.homedir(), accountHome()].flatMap((home) => [home, realpathOrSelf(home)]).map(slashed))];
  return patterns.some((pattern) => homes.some((home) => secretPatternRegExp(pattern, home).test(slashed(resolved))));
}

// An account with no user-database entry (a container run with an arbitrary UID) makes
// `os.userInfo()` throw; $HOME is then the only home available.
function accountHome() {
  if (process.platform === "win32") return os.homedir();
  try {
    return os.userInfo().homedir;
  } catch {
    return os.homedir();
  }
}

function realpathOrSelf(value) {
  try {
    return fs.realpathSync(value);
  } catch {
    return value;
  }
}

// Fixed system temp locations, never $TMPDIR: an environment variable pointed at a broad
// directory would otherwise widen what `pr-body` may read. macOS per-user temp folders live under
// /var/folders. Windows has no fixed per-user location, so %TEMP% is accepted only when it names an
// AppData\Local\Temp folder; anything else fails closed.
function temporaryRoots() {
  if (process.platform === "win32") {
    const temp = realpathOrSelf(os.tmpdir());
    return /\\AppData\\Local\\Temp$/i.test(temp) ? [temp] : [];
  }
  const candidates = ["/tmp", "/var/tmp", ...(process.platform === "darwin" ? ["/var/folders"] : [])];
  return [...new Set(candidates.filter((root) => fs.existsSync(root)).map((root) => fs.realpathSync(root)))];
}

const OPEN_FLAGS = fs.constants.O_RDONLY | (fs.constants.O_NONBLOCK ?? 0) | (fs.constants.O_NOFOLLOW ?? 0);

// Agent permissions allow `delivery pr-body` with any argument, and the command reads the file
// outside the agent's Read tool, so it must enforce what Read would: the body must resolve, after
// symlinks, to a regular file inside a system temp directory that the `read-secrets` denylist does
// not name. The file is then opened and its identity rechecked. On Linux the kernel's own path
// for the open descriptor is compared, which closes a path component swapped mid-check. Elsewhere
// Node has no descriptor-path lookup, so a fresh resolution's device and inode are compared, which
// narrows that window but cannot close it against repeated timed swaps. Refusals and read errors
// never print the path.
function readBodyFile(file) {
  const roots = temporaryRoots();
  let resolved;
  try {
    resolved = fs.realpathSync(file);
  } catch {
    throw new Error("PR body file was not found (path not printed)");
  }
  if (!roots.some((root) => resolved.startsWith(root.endsWith(path.sep) ? root : root + path.sep))) {
    throw new Error(`PR body file must be inside a system temp directory (${roots.join(" or ") || "none available"})`);
  }
  if (isDeniedSecret(resolved)) throw new Error("PR body file matches the read-secrets credential denylist (path not printed)");
  let fd;
  try {
    fd = fs.openSync(resolved, OPEN_FLAGS);
    const opened = fs.fstatSync(fd);
    if (!opened.isFile()) throw new Error("PR body file must be a regular file");
    const recheck = fs.realpathSync(resolved);
    const current = fs.statSync(recheck);
    const changed = recheck !== resolved || current.dev !== opened.dev || current.ino !== opened.ino
      || (process.platform === "linux" && fs.readlinkSync(`/proc/self/fd/${fd}`) !== resolved);
    if (changed) throw new Error("PR body file changed while it was being checked (path not printed)");
    return fs.readFileSync(fd, "utf8");
  } catch (error) {
    if (!error.code) throw error;
    throw new Error(`PR body file could not be read (${error.code}; path not printed)`);
  } finally {
    if (fd !== undefined) fs.closeSync(fd);
  }
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
