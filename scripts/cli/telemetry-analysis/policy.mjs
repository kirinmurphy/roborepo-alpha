// Production finding thresholds. The oracle deliberately defines its own independent policy.
export const SPIKE_SIGMA = 2;
export const MIN_SPIKE_THRESHOLD = 50_000;
export const HEAVY_RESULT_CHARS = 40_000;
export const LOOP_REPEAT_THRESHOLD = 8;
export const LARGE_DOCUMENT_READ_CHARS = 20000;
export const REPEATED_DOCUMENT_READ_COUNT = 2;
export const MIXED_CODE_LOOKUP_NATIVE_READS = 4;
export const DOC_EXTS = new Set([".md", ".mdx", ".rst", ".txt"]);
export const SOURCE_EXTS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".css", ".scss", ".sh", ".py", ".rb", ".go", ".rs", ".java", ".kt", ".swift", ".php", ".cs", ".cpp", ".c", ".h", ".hpp", ".toml", ".yaml", ".yml"]);
