import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

export function hasRootsCapability(server: McpServer) {
  const capabilities = server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "roots" in capabilities && typeof capabilities.roots === "object";
}

export function hasSamplingCapability(server: McpServer) {
  const capabilities = server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "sampling" in capabilities && typeof capabilities.sampling === "object";
}

export function hasElicitationCapability(server: McpServer) {
  const capabilities = server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "elicitation" in capabilities && typeof capabilities.elicitation === "object";
}
