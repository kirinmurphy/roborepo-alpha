// Fictional data only. Feeds the unit goldens, including the 3/12 vs 9/12 example in docs/user/guides/telemetry.md.
import { analyzeTelemetry } from "../../cli/telemetry-analyze.mjs";
export function documentationScenario() {
  const snapshots = [
    { schema: 2, snapshot_id: "configured", packages: ["focused-reads"], skills: ["section-lookup"], evaluability: { packages: true, skills: true } },
    { schema: 2, snapshot_id: "baseline", packages: [], skills: [], evaluability: { packages: true, skills: true } },
  ];
  const events = Array.from({ length: 26 }, (_, index) => {
    const cohort = index < 12 ? 0 : index < 24 ? 1 : 2;
    const affected = index < 3 || (index >= 12 && index < 21);
    return { schema: 3, capture_id: `doc-${index}`, call_id: `call-${index}`, session_id: `session-${index}`, harness: "claude",
      ts: new Date(Date.UTC(2026, 8, 1, index * 6)).toISOString(), event: "PostToolUse",
      session: { model: cohort === 2 ? null : cohort === 0 ? "Model A" : "Model B" },
      repo: { label: "sample-project", repository_id: "git:github.com/example/sample-project" },
      config_snapshot_id: cohort === 2 ? null : cohort === 0 ? "configured" : "baseline",
      tokens: index % 5 === 0 ? null : { input: 10000, output: 2000, cache_read: 1000, cache_creation: 0, total: 13000 },
      delta_tokens: 1000, tool: { name: "Read", file_ext: ".md" }, last_result: { tool: "Read", chars: affected ? 24000 : 500 },
    };
  });
  const markers = [{ schema: 2, marker_id: "mark_0000000000000001", type: "change", title: "Prefer section-level document reads", ts: "2026-09-04T03:00:00Z", effective_at: "2026-09-04T03:00:00Z", scope: "all", watching_kinds: ["read-warning"] }];
  const report = analyzeTelemetry(events, { snapshots, markers });
  return { events, snapshots, markers, report };
}
