// In-repo entry for the terminal command, portal and tests. The real module lives in the context-row
// plugin, which can only import files inside its own folder; package.config.json installs that file
// under this same name beside claude-statusline.mjs. A re-export, not a symlink: npm pack drops symlinks.
export * from "../claude/context-row/lib/usage-render.mjs";
