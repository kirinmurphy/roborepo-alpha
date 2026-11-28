// The GitHub provider's manifest (provider.json), loaded once. The adapter modules read it to name
// their own commands, package, and state folder, so none of those is spelled out twice.
import fs from "node:fs";

export const githubManifest = Object.freeze(JSON.parse(fs.readFileSync(new URL("./provider.json", import.meta.url), "utf8")));

// What the shared finding helpers need from a provider, available before the provider is defined.
export const githubSelf = Object.freeze({ id: githubManifest.id, manifest: githubManifest });
