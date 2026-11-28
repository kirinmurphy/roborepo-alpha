// The shipped forge providers' manifests, without their adapters. Low-level modules that need only a
// provider's data (modules/repositories/git-exec.mjs reads each agent package id) import this instead
// of the registry: the adapters import those modules, so loading the registry from them would be a
// cycle. registry.mjs ships providers whose manifests are exactly these, which
// forge-provider-contract-check.mjs asserts.
import { githubManifest } from "./providers/github/manifest.mjs";

export const SHIPPED_FORGE_MANIFESTS = Object.freeze([githubManifest]);
