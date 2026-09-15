import type { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import type { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import type { McpContext } from "./context.js";

export type ToolMeta = RequestHandlerExtra<ServerRequest, ServerNotification> & {
  ctx: McpContext;
};
