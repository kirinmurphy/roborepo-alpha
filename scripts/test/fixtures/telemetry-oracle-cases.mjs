// Deterministic raw evidence for oracle comparisons; never imported by runtime modules.
export function marker(id, boundary) {
  return { schema: 2, marker_id: id, type: "change", ts: boundary, effective_at: boundary,
    scope: "all", repository_id: null, watching_kinds: ["spike", "loop", "read-warning"] };
}

export function regressionTieCase({ allSameTime = false } = {}) {
  const at = "2026-09-15T12:00:00.000Z", later = allSameTime ? at : "2026-09-16T04:00:00.000Z";
  const row = (id, harness, sessionId, tool, ts, chars) => ({
    schema: 3, capture_id: `cap-${id}`, call_id: `call-${id}`, harness, session_id: sessionId,
    event: "PostToolUse", ts, repo: { label: "repo", repository_id: "git:example/repo" },
    session: { model: "model" }, tool: { name: tool }, last_result: { tool, chars },
    tokens: { input: 1_000, output: 100, total: 1_100 }, delta_tokens: 1_000,
  });
  return { events: [
    row("25-0", "codex", "shared-12", "Edit", at, 25_000),
    row("26-1", "claude", "shared-13", "Edit", at, 2_498),
    row("26-2", "claude", "shared-13", "mcp__jcodemunch__search", at, 2_632),
    row("27-0", "codex", "shared-13", "Bash", later, 4_395),
  ], snapshots: [], markers: [] };
}

function random(seed) {
  let state = seed >>> 0;
  return () => ((state ^= state << 13, state ^= state >>> 17, state ^= state << 5, state >>>= 0) / 0x1_0000_0000);
}

export function seededCase(seed) {
  const next = random(seed), boundary = "2026-09-15T12:00:00.000Z";
  const snapshots = [
    { schema: 2, snapshot_id: "cfg-on", packages: ["pkg-a"], skills: ["skill-a"], evaluability: { packages: true, skills: true } },
    { schema: 2, snapshot_id: "cfg-off", packages: [], skills: [], evaluability: { packages: true, skills: true } },
  ];
  const events = [];
  for (let index = 0; index < 28; index++) {
    const harness = index % 2 ? "codex" : "claude", sessionId = `shared-${Math.floor(index / 2)}`;
    const snapshot = index === 1 || index === 2 ? null : index % 2 ? "cfg-on" : "cfg-off";
    const model = index % 7 === 0 ? null : index % 3 ? "model-a" : "model-b";
    const repositoryId = index % 9 === 0 ? null : index % 2 ? "git:example/repo-a" : "git:example/repo-b";
    const calls = index === 2 ? 8 : 2 + Math.floor(next() * 3);
    for (let call = 0; call < calls; call++) {
      let time;
      if (index === 24) time = Date.parse(boundary) + (call ? 3_600_000 : -3_600_000);
      else if (index === 25) time = Date.parse(boundary) + call * 60_000;
      else if (index === 26) time = Date.parse(boundary);
      else if (index < 12) time = Date.parse(boundary) - (index + 1) * 3_600_000 + call * 1_000;
      else time = Date.parse(boundary) + (index - 11) * 3_600_000 + call * 1_000;
      const isDoc = index % 5 === 0 && call < 2;
      const toolName = index === 2 ? "Read" : ["Read", "Edit", "Bash", "mcp__jcodemunch__search"][Math.floor(next() * 4)];
      const tokenless = index % 8 === 0 || (index === 27 && call === calls - 1);
      const spike = [3, 5, 17, 19, 23, 27].includes(index) && call === calls - 1;
      const base = {
        schema: 3, capture_id: `cap-${index}-${call}`, call_id: `call-${index}-${call}`, harness, session_id: sessionId,
        event: "PostToolUse", ts: new Date(time).toISOString(), config_snapshot_id: snapshot,
        repo: { label: repositoryId?.split("/").at(-1) ?? "unknown", repository_id: repositoryId }, session: { model },
        tool: { name: toolName, mcp_tool: toolName.startsWith("mcp__") ? toolName : null,
          file_ext: isDoc ? ".md" : toolName === "Read" ? ".mjs" : null, file_path_hash: isDoc ? `doc-${index}` : null,
          command_chars: toolName === "Bash" ? 10 : 0 },
        last_result: { tool: toolName, chars: isDoc ? 25_000 : 400 + Math.floor(next() * 4_000) },
        tokens: tokenless ? null : { input: 1_000 + call * 100, output: 100, total: 1_100 + call * 100 },
        delta_tokens: spike ? 300_000 : 500 + Math.floor(next() * 4_000),
      };
      if (call === 0 && index % 5 === 0 && index !== 25) events.push({ ...base, capture_id: `mirror-pre-${index}`, event: "PreToolUse", ts: new Date(time - 500).toISOString() });
      events.push(base);
    }
  }
  return { events, snapshots, markers: [marker(`seed-${seed}`, boundary)] };
}
