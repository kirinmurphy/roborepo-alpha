// Package MCP preset methods for providers that register a server by writing their own config file
// (Codex's TOML table, Gemini's mcpServers key). Built from the provider's own single-server
// addServer/removeServer/list, so each provider keeps its file format and this keeps the
// already-present and absent checks in one place.

import { validateAdapterComputeResult } from "./schemas.mjs";

export function configFileMcpPresetMethods(providerId, { addServer, removeServer, list }) {
  const label = providerId[0].toUpperCase() + providerId.slice(1);

  function installPreset(spec, io) {
    if (list({ configPath: io.configPath }).includes(spec.name)) {
      console.log(`${providerId} MCP already present: ${spec.name}`);
      return;
    }
    const result = addServer(spec, { configPath: io.configPath });
    validateAdapterComputeResult(result);
    io.write(result.content);
    console.log(`${providerId} MCP added: ${spec.name} -> ${io.configPath}`);
  }

  function removePreset(name, io) {
    const result = removeServer(name, { configPath: io.configPath });
    validateAdapterComputeResult(result);
    if (!result.changed) {
      console.log(`ok: ${label} MCP already absent: ${name}`);
      return;
    }
    io.write(result.content);
    console.log(`${providerId} MCP removed: ${name} <- ${io.configPath}`);
  }

  function hasServer(name, { configPath }) {
    return list({ configPath }).includes(name);
  }

  return { installPreset, removePreset, hasServer };
}
