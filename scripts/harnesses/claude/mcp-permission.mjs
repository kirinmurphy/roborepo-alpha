// The `mcp__<server>` allow entry Claude needs before a session may call a registered MCP server.
// Pure: takes parsed settings and adds the entry beside the other MCP grants, so both the package
// system (through the provider) and `roborepo mcp add` grant it the same way.

function nextMcpPermissionIndex(allow) {
  for (let i = allow.length - 1; i >= 0; i--) {
    if (allow[i].startsWith("mcp__")) return i + 1;
  }
  return 0;
}

// Returns the permission and whether settings changed; mutates settings in place.
export function addMcpPermission(settings, serverName) {
  const permission = `mcp__${serverName}`;
  settings.permissions ||= {};
  settings.permissions.allow ||= [];
  if (settings.permissions.allow.includes(permission)) return { permission, changed: false };
  settings.permissions.allow.splice(nextMcpPermissionIndex(settings.permissions.allow), 0, permission);
  return { permission, changed: true };
}
