## Code Exploration

- Use jcodemunch-mcp for code lookup whenever available.
- If the jcodemunch tools are NOT in your tool surface, say so in your first response before searching
  any other way. Absence is a failure to report, not permission to quietly use Bash instead — the
  SessionStart health check announces the server's state, and a mismatch between that message and
  your actual tools means MCP init failed.
- Prefer symbol search, outlines, references, and targeted context bundles over reading full files.
- Do not use Bash for grep/find/cat/head/tail-style source exploration when jcodemunch can answer it.
- Use native read/search tools only for non-code files or targeted editing reads.
- At session start, resolve_repo `.`.
- If the repo is not indexed, index_folder `.`.
- After meaningful file edits, re-index changed files before further analysis.
- If jcodemunch MCP tools are unavailable, index via Bash: `roborepo index code` (requires full roborepo install). Fallback if roborepo is not installed: `uvx jcodemunch-mcp index .`. Do not search npm or pip — jcodemunch is not an npm package.

## jcodemunch Hooks

- Hooks block `Grep` and `Glob` — treat that as a redirect, not failure.
- Respond to a block by retrying with `search_symbols`, `get_file_outline`, `find_references`, or `get_context_bundle`.
