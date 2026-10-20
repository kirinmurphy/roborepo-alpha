import { buildRootConfigView, ROOT_CONFIG_STATE_LABEL } from "./root-config-view.mjs";
import { formatBytes } from "../../modules/retention/index.mjs";

// Read-only report of baseline vs. active root config vs. drift state, per harness. No writes;
// update and repair act on this same drift signal.
export function configRootInspect() {
  for (const row of buildRootConfigView()) {
    console.log(`\n${row.harness}`);
    console.log(`  baseline: ${row.baseline}${row.baselineExists ? "" : "  (missing)"}`);
    console.log(`  active:   ${row.active}${row.activeExists ? "" : "  (missing)"}`);
    console.log(`  status:   ${ROOT_CONFIG_STATE_LABEL[row.state] ?? row.state}`);
    if (row.state === "drifted") {
      console.log(`  last-known hash:  ${row.lastHash}`);
      console.log(`  current hash:     ${row.currentHash}`);
      console.log(`  run \`roborepo update\` to resolve — see docs/user/reference/config-collision-handling.md`);
      // Codex owns a native profile mechanism for permanent personal config; point drifted Codex
      // users at it instead of re-drifting the managed baseline every update. Claude has no
      // equivalent, so this hint is Codex-only.
      if (row.harness === "codex") {
        console.log(`  for a permanent personal slice, use a Codex profile (~/.codex/<name>.config.toml, --profile <name>)`);
      }
    }
    if (row.stagedUpdate) {
      console.log(`  staged update:    ${row.stagedUpdate}`);
    }
  }
  console.log("");
}

// One permission row: named behavior and arbitrary command print identically, because which kind
// an entry is has no bearing on what the reader does with it.
function printPermissionRow(item) {
  // "added" distinguishes a command the user introduced (no default to state) from one they
  // re-bucketed. Deleting the first removes it; deleting the second restores the default.
  const override = item.overridden && item.defaultBucket
    ? `  (custom, default: ${item.defaultBucket})`
    : item.overridden ? "  (custom, added)" : "";
  const codexNote = item.codexOnly ? "  [Codex only]" : "";
  console.log(`  ${item.bucket.padEnd(6)} ${item.label}${override}${codexNote}`);
  if (item.description) console.log(`         ${item.description}`);
}

// Permissions splits into what the user changed and what shipped as-is — the same split the portal
// draws. The user's own settings print in full however many there are; the defaults collapse to
// per-category counts, since 38 unchanged rows are noise in a status report.
function printPermissions(section) {
  const items = section.items || [];
  const yours = items.filter((item) => item.overridden);
  const defaults = items.filter((item) => !item.overridden);

  console.log(`  Yours (${yours.length})`);
  if (yours.length === 0) {
    console.log("    nothing customized — all permissions are at their shipped defaults");
  }
  for (const item of yours) printPermissionRow(item);

  // Defaults print as per-category counts rather than rows. The portal is where you browse them;
  // in a status report the useful signal is "these groups exist and nothing in them is customized",
  // which a count conveys and 38 lines of allow/allow/allow do not.
  console.log(`\n  Defaults (${defaults.length})`);
  const counted = new Set();
  for (const category of section.categories || []) {
    const rows = defaults.filter((item) => item.category === category.id);
    for (const row of rows) counted.add(row);
    if (rows.length > 0) console.log(`    ${String(rows.length).padStart(3)}  ${category.label}`);
  }
  const uncategorized = defaults.filter((item) => !counted.has(item));
  if (uncategorized.length > 0) console.log(`    ${String(uncategorized.length).padStart(3)}  Other`);
  console.log("    see them all: roborepo web");
}

// Renders the behaviorView (from buildBehaviorView) as the `roborepo config status` terminal report.
export function printConfigStatus(view) {
  const check = (v) => (v ? "[x]" : "[ ]");

  for (const section of view) {
    const header = section.description
      ? `\n${section.category}  (${section.description})`
      : `\n${section.category}`;
    console.log(header);
    // Harness-level caveats for this section, shown once rather than repeated on every affected
    // item. Text comes from the provider manifest, so no harness is named in platform code.
    for (const notice of section.notices || []) console.log(`  note: ${notice.note}`);
    // Permissions groups by authorship instead of listing flat, matching the portal.
    if (section.kind === "permissions") {
      printPermissions(section);
      if (section.footnote) console.log(`\n  * ${section.footnote}`);
      continue;
    }
    for (const item of section.items) {
      if (item.kind === "behavior" || item.kind === "arbitrary-item") {
        printPermissionRow(item);
      } else if (item.kind === "store") {
        // Size against bound, not an on/off state — a store is never "enabled", it just holds data.
        const size = item.maxBytes
          ? `${formatBytes(item.bytes)} of ${formatBytes(item.maxBytes)}`
          : formatBytes(item.bytes);
        console.log(`  ${item.label}  ${size}${item.over ? "  (over cap)" : ""}`);
        console.log(`      ${item.path}`);
      } else if (item.kind === "info") {
        console.log(`  ${item.label}`);
        if (item.description) console.log(`    ${item.description}`);
      } else if (item.kind === "expandable") {
        console.log(`  ${item.label}`);
        if (item.detail?.length) {
          const show = item.detail.slice(0, 5);
          for (const d of show) console.log(`    · ${d}`);
          if (item.detail.length > 5) console.log(`    … (${item.detail.length - 5} more)`);
        }
      } else {
        const badges = item.badges?.length ? "  " + item.badges.map((b) => `[${b}]`).join(" ") : "";
        console.log(`  ${check(item.active)} ${item.label}${badges}`);
        if (item.description) console.log(`      ${item.description}`);
        if (!item.active && item.hint) console.log(`      → ${item.hint}`);
      }
    }
    if (section.footnote) console.log(`\n  * ${section.footnote}`);
  }

  console.log("");
}
