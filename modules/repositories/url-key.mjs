import { createHash } from "node:crypto";

export const URL_KEY_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
export const URL_KEY_MAX_LENGTH = 80;

export function validateRepositoryUrlKey(value) {
  if (typeof value !== "string" || value.length > URL_KEY_MAX_LENGTH || !URL_KEY_PATTERN.test(value)) {
    throw new Error("repository urlKey is invalid");
  }
  return value;
}

export function allocateRepositoryUrlKey(registry, { repositoryId, displayName }) {
  const base = slugBase(displayName);
  const used = new Set(Object.values(registry.repositories || {}).map((record) => record.urlKey).filter(Boolean));
  if (!used.has(base)) return base;

  const hash = BigInt(`0x${createHash("sha256").update(repositoryId).digest("hex")}`).toString(36);
  for (let suffixLength = 4; suffixLength <= hash.length; suffixLength += 1) {
    const suffix = hash.slice(0, suffixLength);
    const candidateBase = base.slice(0, URL_KEY_MAX_LENGTH - suffix.length - 1).replace(/-+$/g, "") || "repository";
    const candidate = `${candidateBase}-${suffix}`;
    if (!used.has(candidate)) return candidate;
  }
  throw new Error("unable to allocate a unique repository urlKey");
}

export function repositoryUrl(urlKey) {
  return `/repositories/${validateRepositoryUrlKey(urlKey)}`;
}

function slugBase(displayName) {
  const normalized = String(displayName || "")
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "repository";
  return normalized.slice(0, URL_KEY_MAX_LENGTH).replace(/-+$/g, "") || "repository";
}
