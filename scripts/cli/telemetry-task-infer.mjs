// Pure, explainable task category/scale inference. Zero fs/config dependency, same discipline as telemetry-classify.mjs
// and telemetry-phase-infer.mjs. Operates only on already-summarized, privacy-safe file-touch
// signals (extension/category counts, insertion/deletion totals) — never raw paths or diff content.
export const TASK_CLASSIFIER_VERSION = 1;

const DOC_EXTENSIONS = new Set(["md", "mdx", "rst", "txt"]);
const UI_EXTENSIONS = new Set(["jsx", "tsx", "css", "scss", "html", "vue", "svelte"]);
const CONFIG_EXTENSIONS = new Set(["json", "yaml", "yml", "toml", "ini", "env"]);
const GENERATED_MARKERS = new Set(["generated", "dist", "build", "lock"]);

// `signals` shape:
// - changedFileCategories: string[] — extension-derived categories per changed file, e.g.
//   ["doc", "code", "config"] (callers build this from file_ext, never a raw path)
// - directoriesTouched: number
// - insertions / deletions: number | null (from `git diff --numstat`-shaped counts, if available)
// - testFilesTouched: boolean — at least one changed file looked like a test file
// - hadTestFailureBeforeEdits: boolean — a failing test preceded the edits (bug-fix signal)
export function inferTaskCategory(signals = {}) {
  const {
    changedFileCategories = [],
    testFilesTouched = false,
    hadTestFailureBeforeEdits = false,
  } = signals;

  const categories = new Set(changedFileCategories);
  const onlyDocs = categories.size > 0 && [...categories].every((c) => c === "doc");
  const onlyUi = categories.size > 0 && [...categories].every((c) => c === "ui");
  const onlyConfig = categories.size > 0 && [...categories].every((c) => c === "config");

  if (onlyDocs) return classification("documentation", 0.8);
  if (hadTestFailureBeforeEdits) return classification("bug-fix", testFilesTouched ? 0.75 : 0.6);
  if (onlyUi) return classification("ui", 0.7);
  if (onlyConfig) return classification("dependency-configuration", 0.65);
  if (categories.size >= 3) return classification("refactor", 0.5);
  return classification("unknown", 0);
}

function classification(category, confidence) {
  return { task_category: category === "unknown" || confidence < 0.5 ? "unknown" : category, task_category_source: "inferred", confidence };
}

// Categorizes a single file extension without exposing the file path itself (code,
// configuration, documentation, or generated-file mix). Callers pass file_ext (already extracted
// elsewhere, e.g. telemetry-capture.mjs's fileExt()) plus an optional path-shape hint that itself
// must not be persisted — only this function's return value is stored.
export function categorizeFile(ext, { looksGenerated = false } = {}) {
  if (looksGenerated) return "generated";
  if (typeof ext !== "string" || !ext) return "unknown";
  const lower = ext.toLowerCase();
  if (DOC_EXTENSIONS.has(lower)) return "doc";
  if (UI_EXTENSIONS.has(lower)) return "ui";
  if (CONFIG_EXTENSIONS.has(lower)) return "config";
  if (GENERATED_MARKERS.has(lower)) return "generated";
  return "code";
}

// `signals` shape:
// - filesTouched, directoriesTouched: number
// - insertions, deletions: number | null
// - changedFileCategories: string[] (same shape as inferTaskCategory's input)
export function inferTaskScale(signals = {}) {
  const {
    filesTouched = 0,
    directoriesTouched = 0,
    insertions = null,
    deletions = null,
    changedFileCategories = [],
  } = signals;

  const categories = new Set(changedFileCategories);
  const surface = categories.size === 0 ? "unknown" : categories.size > 1 ? "mixed" : [...categories][0] === "doc" ? "documentation" : [...categories][0] === "config" ? "configuration" : [...categories][0] === "generated" ? "generated" : "code";

  return {
    files_touched: filesTouched,
    directories_touched: directoriesTouched,
    insertions,
    deletions,
    // Cross-cutting: touches enough distinct directories that the change isn't confined to one area.
    // Three is the same "spread" threshold used nowhere else yet — chosen as a conservative floor
    // (2 directories is still plausibly one feature's implementation + its test file).
    cross_cutting: directoriesTouched >= 3,
    surface,
  };
}
