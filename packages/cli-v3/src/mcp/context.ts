import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { FileLogger } from "./logger.js";
import { LoginResult } from "../utilities/session.js";

export type McpContextOptions = {
  login: LoginResult;
  projectRef?: string;
  fileLogger?: FileLogger;
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
