import { RequestHandlerExtra } from "@modelcontextprotocol/sdk/shared/protocol.js";
import { ServerNotification, ServerRequest } from "@modelcontextprotocol/sdk/types.js";
import { McpContext } from "./context.js";

export type ToolMeta = RequestHandlerExtra<ServerRequest, ServerNotification> & {
  ctx: McpContext;
};
