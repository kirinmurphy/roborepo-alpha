// Codex-native projection of resolved credential intent. Rendering is not runtime certification:
// callers must verify the selected profile and platform with the native enforcement runner.
export function codexCredentialPermissions(behaviors) {
  const secrets = behaviors.find((behavior) => behavior.id === "read-secrets");
  if (secrets?.bucket !== "deny") {
    return {
      paths: [],
      notes: secrets?.bucket === "ask" ? ["Credential path-specific prompting is unsupported; no credential denies rendered."] : [],
    };
  }
  const paths = (secrets.paths ?? []).map((pattern) => {
    // Claude spells absolute anchors with two slashes; Codex accepts one. Home anchors resolve
    // in the runtime's home, so packed output never captures the builder's home directory.
    if (pattern.startsWith("~/")) return pattern;
    if (pattern.startsWith("//")) return pattern.slice(1);
    if (pattern.startsWith("/")) return pattern;
    throw new Error(`Unsupported Codex credential anchor: ${pattern}`);
  });
  return {
    paths: [...new Set(paths)],
    notes: [
      "Credential denies block reads and writes inside the selected native sandbox.",
      "Enforcement requires runtime verification; browser, MCP and escalated processes are unverified.",
      "Unbounded deny globs require platform support; Linux and Windows coverage is unverified.",
    ],
  };
}
