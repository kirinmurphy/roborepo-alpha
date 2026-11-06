import fs from "node:fs";
import path from "node:path";
import { GIT_MAX_BINARY_BUFFER, runGitProcess } from "./git-exec.mjs";

const BUILD_MARKERS = ["pyproject.toml", "setup.py", "setup.cfg", "package.json", "CMakeLists.txt", "Makefile"];

// Git's directory aggregation bounds discovery to ignored paths. Inspect each aggregate rather
// than exempting an ignored parent that happens to contain a generated directory.
export async function discoverWorktreeArtifacts(cwd, { git = (args, options) => runGitProcess(cwd, args, options), fsApi = fs, deadline = Infinity } = {}) {
  const read = async (args) => {
    checkDeadline(deadline);
    const result = await git(args, { maxBuffer: GIT_MAX_BINARY_BUFFER });
    if (!result.ok) throw new Error(result.error || "ignored files status unavailable");
    return result.stdout.split("\0").filter(Boolean);
  };
  const ignored = await read(["ls-files", "--others", "--ignored", "--exclude-standard", "--directory", "-z"]);
  // A staged deletion can leave a committed file on disk under an ignored directory.
  const tracked = [
    ...await read(["ls-files", "--cached", "-z"]),
    ...await read(["ls-tree", "-r", "--name-only", "-z", "HEAD"]),
  ];
  const disposable = [];
  const protectedPaths = [];
  const scanned = new Map();
  const trackedBelow = (relative) => tracked.some((file) => file === relative || file.startsWith(`${relative}/`));
  const marker = (relative) => {
    try { return fsApi.lstatSync(path.join(cwd, relative)).isFile(); } catch (error) { if (["ENOENT", "ENOTDIR"].includes(error.code)) return false; throw error; }
  };
  const scan = (relative) => {
    checkDeadline(deadline, relative);
    if (scanned.has(relative)) return scanned.get(relative);
    const stat = fsApi.lstatSync(path.join(cwd, relative));
    let result = { stat, files: stat.isDirectory() ? 0 : 1, bytes: stat.isDirectory() ? 0 : stat.size, git: path.posix.basename(relative).toLowerCase() === ".git", bytecode: stat.isFile() && /\.py[co]$/.test(relative) };
    if (stat.isDirectory() && !result.git) {
      const children = fsApi.readdirSync(path.join(cwd, relative)).sort();
      result = { ...result, children, bytecode: true };
      for (const child of children) {
        const entry = scan(`${relative}/${child}`);
        result.files += entry.files;
        result.bytes += entry.bytes;
        result.git ||= entry.git;
        // A bytecode cache contains files only, not subdirectories or symlinks.
        result.bytecode &&= entry.stat.isFile() && entry.bytecode;
      }
    }
    scanned.set(relative, result);
    return result;
  };
  const visit = (relative) => {
    checkDeadline(deadline, relative);
    const entry = scan(relative);
    const name = path.posix.basename(relative);
    const parent = path.posix.dirname(relative);
    let shape = false;
    if (entry.stat.isDirectory() && !entry.git && !trackedBelow(relative)) {
      if (["node_modules", "test-results"].includes(name)) shape = parent === "." || marker(`${parent}/package.json`);
      else if (name === ".venv") shape = marker(`${relative}/pyvenv.cfg`);
      else if (name === "__pycache__") shape = entry.bytecode;
      else if (name.endsWith(".egg-info")) shape = marker(`${relative}/PKG-INFO`);
      else if (name === "build") shape = BUILD_MARKERS.some((file) => marker(`${parent}/${file}`));
    }
    if (shape) { disposable.push({ path: relative, files: entry.files, bytes: entry.bytes }); return; }
    if (!entry.stat.isDirectory() || entry.git || !entry.children.length) { protectedPaths.push(relative); return; }
    if (name.toLowerCase() === ".git") { protectedPaths.push(relative); return; }
    for (const child of entry.children) visit(`${relative}/${child}`);
  };
  for (const item of ignored) visit(item.replace(/\/$/, ""));
  return { disposable, protected: protectedPaths, ignored };
}

function checkDeadline(deadline, relative = null) {
  if (Date.now() > deadline) throw new Error(`artifact inventory exceeded time budget${relative ? `: ${relative}` : ""}`);
}
