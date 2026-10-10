## Doc Exploration

- Use jdocmunch-mcp for documentation lookup whenever available.
- Prefer search_sections, get_toc, get_section over reading full `.md` and `.rst` files.
- At session start, call list_repos to see what docs are already indexed.
- To index local docs, call index_local with the docs folder path, or run
  `roborepo index docs docs/` from the CLI.
- After reading a plan or doc once, reuse gathered anchors and facts in the current turn.
- Do not reread a full plan/doc unless it changed, the user asked for a fresh full review, or the first read was insufficient and you state why.
- Use targeted section or line-range checks when verifying one specific detail from source.
- After editing doc files, index updates passively via mtime detection.
- For new or deleted doc files, call index_local again.
