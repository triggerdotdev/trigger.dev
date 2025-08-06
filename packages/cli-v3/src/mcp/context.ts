import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FileLogger } from "./logger.js";

export type McpContextOptions = {
  projectRef?: string;
  fileLogger?: FileLogger;
  apiUrl?: string;
  profile?: string;
};

export class McpContext {
  public readonly server: McpServer;
  public readonly options: McpContextOptions;

  constructor(server: McpServer, options: McpContextOptions) {
    this.server = server;
    this.options = options;
  }

  get logger() {
    return this.options.fileLogger;
  }
}
