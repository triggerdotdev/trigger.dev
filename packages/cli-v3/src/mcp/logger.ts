import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { appendFileSync } from "node:fs";
import util from "node:util";

export class FileLogger {
  private filePath: string;
  private server: McpServer;

  constructor(filePath: string, server: McpServer) {
    this.filePath = filePath;
    this.server = server;
  }

  log(message: string, ...args: unknown[]) {
    const logMessage = `[${new Date().toISOString()}][${this.formatServerInfo()}] ${message} - ${util.inspect(
      args,
      {
        depth: null,
        colors: false,
      }
    )}\n`;
    appendFileSync(this.filePath, logMessage);
  }

  private formatServerInfo() {
    return `${this.formatClientName()} ${this.formatClientVersion()} ${this.formatClientCapabilities()}`;
  }

  private formatClientName() {
    const clientName = this.server.server.getClientVersion()?.name;
    return `client=${clientName ?? "unknown"}`;
  }

  private formatClientVersion() {
    const clientVersion = this.server.server.getClientVersion();

    return `version=${clientVersion?.version ?? "unknown"}`;
  }

  private formatClientCapabilities() {
    const clientCapabilities = this.server.server.getClientCapabilities();

    const keys = Object.keys(clientCapabilities ?? {});

    return `capabilities=${keys.join(",")}`;
  }
}
