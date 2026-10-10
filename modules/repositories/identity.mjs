import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { KNOWN_PROVIDER_HOSTS } from "./config.mjs";

// Namespacing salt for opaque local-root and local-repository ids. Not secret; it only keeps these
// hashes from colliding with any other sha256-of-path scheme elsewhere in roborepo. Kept stable
// forever so ids remain reproducible across runs/machines for the same realpath.
const LOCAL_ID_SALT = "roborepo/repositories/v1";

export function normalizeGitRemote(value) {
  if (!value || typeof value !== "string") return null;
  const trimmed = value.trim();
  if (!trimmed) return null;

  let host;
  let repoPath;
  const scpLike = trimmed.match(/^(?:[^@/\s]+@)?([^:\s]+):(.+)$/);
  if (scpLike && !trimmed.includes("://")) {
    host = scpLike[1];
    repoPath = scpLike[2];
  } else {
    try {
      const url = new URL(trimmed);
      host = url.hostname;
      repoPath = url.pathname.replace(/^\/+/, "");
    } catch {
      return null;
    }
  }

  if (!host || !repoPath) return null;
  repoPath = repoPath
    .replace(/[?#].*$/, "")
    .replace(/\/+$/, "")
    .replace(/\.git$/i, "");
  if (!repoPath || repoPath.includes("..")) return null;
  return `git:${host.toLowerCase()}/${repoPath}`;
}

export function findProjectRoot(startDir, { fsApi = fs, pathApi = path } = {}) {
  if (!startDir || typeof startDir !== "string") return null;
  let current = pathApi.resolve(startDir);
  for (;;) {
    const gitPath = pathApi.join(current, ".git");
    if (exists(fsApi, gitPath)) return current;
    const parent = pathApi.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

export function resolveProjectIdentity(cwd, commandName, options = {}) {
  const { fsApi = fs, pathApi = path } = options;
  const realCwd = realpathSafe(fsApi, pathApi.resolve(cwd || ""));
  const projectRoot = findProjectRoot(realCwd, { fsApi, pathApi });
  if (projectRoot) {
    const remote = readGitRemote(projectRoot, { fsApi, pathApi });
    if (remote) {
      return {
        identity: remote,
        identityKind: "git",
        confidence: "high",
        projectRoot,
        evidence: "Git remote",
      };
    }
    return {
      identity: `path:${realpathSafe(fsApi, projectRoot)}`,
      identityKind: "path",
      confidence: "medium",
      projectRoot,
      evidence: "project directory",
    };
  }

  return {
    identity: `process:${realCwd}:${safeCommandName(commandName)}`,
    identityKind: "process",
    confidence: "low",
    projectRoot: null,
    evidence: "process working directory",
  };
}

// Canonical repository id for a resolved identity.
//   git  -> the normalized `git:host/owner/repo` (portable across machines)
//   path -> an opaque `local:<hash>` derived from the realpath (never exposes the path outward)
//   process/other -> null (a process-only observation is not yet a repository)
// `resolved` is the object returned by resolveProjectIdentity.
export function canonicalRepositoryId(resolved) {
  if (!resolved || typeof resolved !== "object") return null;
  if (resolved.identityKind === "git") return resolved.identity;
  const root = resolved.projectRoot;
  if (resolved.identityKind === "path" && typeof root === "string" && root) {
    return localRepositoryId(root);
  }
  return null;
}

// Opaque, stable, path-free id for a repository that has no usable git remote. Shares the
// sha256-hex-16 shape that plan-suite's stableKey uses so a `local:` id and a plan-suite repo id
// derived from the same realpath agree on the underlying hash.
//
// IMPORTANT: the input MUST already be a realpath. The `local:` id is only stable across domains if
// every producer canonicalizes the path the same way — resolveProjectIdentity realpaths its root,
// so any other caller (Telemetry capture, Plans) must realpath too or a symlinked repo mints
// diverging ids. Callers that hold a possibly-symlinked path should use localRepositoryIdForRoot,
// which realpaths first.
export function localRepositoryId(realpath) {
  return `local:${hashPath(realpath)}`;
}

// Realpath a path (falling back to the raw value on error), using the same discipline the resolver
// applies. Exported so every domain canonicalizes paths identically.
export function realpathOf(value, fsApi = fs) {
  return realpathSafe(fsApi, value);
}

// Convenience: realpath a root then derive its local: id. Prevents the symlink-divergence bug by
// making the realpath step impossible to skip.
export function localRepositoryIdForRoot(root, fsApi = fs) {
  return localRepositoryId(realpathSafe(fsApi, root));
}

// Build a browser-safe https provider URL for a canonical git id, or null. Only recognized hosts
// get a URL (avoids emitting links for hosts whose web layout we can't assume). A `local:` id has
// no provider and returns null. Never emits credentials — the id is already credential-free.
export function providerUrlForRepositoryId(repositoryId) {
  if (typeof repositoryId !== "string" || !repositoryId.startsWith("git:")) return null;
  const rest = repositoryId.slice("git:".length);
  const slash = rest.indexOf("/");
  if (slash <= 0) return null;
  const host = rest.slice(0, slash);
  const repoPath = rest.slice(slash + 1);
  if (!KNOWN_PROVIDER_HOSTS.has(host) || !repoPath || repoPath.includes("..")) return null;
  return `https://${host}/${repoPath}`;
}

// Opaque id for a specific on-disk root (a clone or worktree location). Distinct clones of one
// remote get distinct rootIds while sharing one canonical repositoryId.
export function rootId(realpath) {
  return hashPath(realpath);
}

// Resolve the shared/common git directory for a root. For an ordinary clone this is `<root>/.git`.
// For a linked worktree (`.git` is a file containing `gitdir: <path>`), the per-worktree gitdir
// holds a `commondir` pointer to the primary repository's git directory. Returning that common dir
// lets callers treat every worktree of one repository as the same canonical repository.
// Returns { gitDir, commonDir, isWorktree, worktreeName } or null when no git dir is found.
//
// `worktreeName` is Git's administrative name for a linked worktree — the final segment of its
// per-worktree gitdir (`<common>/worktrees/<name>`), null for a main checkout. It is the portable
// identity plans record in their `worktree` frontmatter: repository-local, path-free, independent of
// the checked-out branch. It is NOT the checkout directory's basename; Git suffixes the
// administrative name when two worktrees share a directory name.
export function resolveGitDir(projectRoot, options = {}) {
  const { fsApi = fs, pathApi = path } = options;
  const gitPath = pathApi.join(projectRoot, ".git");
  let gitDir;
  try {
    const stat = fsApi.statSync(gitPath);
    if (stat.isDirectory()) {
      gitDir = gitPath;
    } else if (stat.isFile()) {
      const content = fsApi.readFileSync(gitPath, "utf8");
      const match = content.match(/^gitdir:\s*(.+)$/m);
      if (!match) return null;
      gitDir = pathApi.resolve(projectRoot, match[1].trim());
    } else {
      return null;
    }
  } catch {
    return null;
  }

  let commonDir = gitDir;
  try {
    const commonPath = pathApi.join(gitDir, "commondir");
    const raw = fsApi.readFileSync(commonPath, "utf8").trim();
    if (raw) commonDir = pathApi.resolve(gitDir, raw);
  } catch {
    // No commondir file -> this gitDir is itself the common dir (ordinary clone).
  }

  const isWorktree = commonDir !== gitDir;
  return { gitDir, commonDir, isWorktree, worktreeName: isWorktree ? pathApi.basename(gitDir) : null };
}

// The main checkout shared by any of these checkout paths (main or linked worktree), or null.
// Confirmed from both ends: the common directory must be a non-bare `.git`, and the directory
// holding it must itself resolve to that same git directory as an ordinary (non-worktree) checkout.
export function mainCheckoutPath(checkoutPaths, options = {}) {
  const { pathApi = path } = options;
  for (const checkoutPath of checkoutPaths) {
    const resolved = resolveGitDir(checkoutPath, options);
    if (!resolved || pathApi.basename(resolved.commonDir) !== ".git") continue;
    const mainRoot = pathApi.dirname(resolved.commonDir);
    const main = resolveGitDir(mainRoot, options);
    if (main && !main.isWorktree && main.gitDir === resolved.commonDir) return mainRoot;
  }
  return null;
}

function readGitRemote(projectRoot, { fsApi, pathApi }) {
  const resolved = resolveGitDir(projectRoot, { fsApi, pathApi });
  if (!resolved) return null;
  // Prefer the common dir's config so a linked worktree reads the primary repository's origin
  // remote and therefore resolves to the same canonical git id as its main clone.
  const configPath = pathApi.join(resolved.commonDir, "config");
  try {
    const config = fsApi.readFileSync(configPath, "utf8");
    const origin = remoteUrlFromConfig(config);
    return normalizeGitRemote(origin);
  } catch {
    return null;
  }
}

function remoteUrlFromConfig(config) {
  let inOrigin = false;
  for (const raw of config.split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith("[remote ")) {
      inOrigin = /^\[remote\s+"origin"\]$/.test(line);
      continue;
    }
    if (inOrigin) {
      const match = line.match(/^url\s*=\s*(.+)$/);
      if (match) return match[1].trim();
    }
  }
  return null;
}

function hashPath(value) {
  return createHash("sha256").update(`${LOCAL_ID_SALT} ${String(value)}`).digest("hex").slice(0, 16);
}

function realpathSafe(fsApi, value) {
  try {
    return fsApi.realpathSync(value);
  } catch {
    return value;
  }
}

function exists(fsApi, filePath) {
  try {
    fsApi.accessSync(filePath);
    return true;
  } catch {
    return false;
  }
}

function safeCommandName(value) {
  return String(value || "unknown").replace(/[^\w.-]/g, "_").slice(0, 80);
}
