import { McpContext } from "./context.js";

export function hasRootsCapability(context: McpContext) {
  const capabilities = context.server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "roots" in capabilities && typeof capabilities.roots === "object";
}

export function hasSamplingCapability(context: McpContext) {
  const capabilities = context.server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "sampling" in capabilities && typeof capabilities.sampling === "object";
}

export function hasElicitationCapability(context: McpContext) {
  const capabilities = context.server.server.getClientCapabilities();

  if (!capabilities) {
    return false;
  }

  return "elicitation" in capabilities && typeof capabilities.elicitation === "object";
}
