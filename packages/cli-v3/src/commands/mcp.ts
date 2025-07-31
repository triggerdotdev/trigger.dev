import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { login } from "./login.js";
import { performSearch } from "../mcp/mintlifyClient.js";
import { logger } from "../utilities/logger.js";
import { FileLogger } from "../mcp/logger.js";

const McpCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  logFile: z.string().optional(),
});

export type McpCommandOptions = z.infer<typeof McpCommandOptions>;

export function configureMcpCommand(program: Command) {
  return commonOptions(
    program
      .command("mcp")
      .description("Run the MCP server")
      .option("-p, --project-ref <project ref>", "The project ref to use")
      .option("--log-file <log file>", "The file to log to")
  ).action(async (options) => {
    wrapCommandAction("mcp", McpCommandOptions, options, async (opts) => {
      await mcpCommand(opts);
    });
  });
}

export async function mcpCommand(options: McpCommandOptions) {
  logger.loggerLevel = "none";

  const authorization = await login({
    embedded: true,
    silent: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
  });

  if (!authorization.ok) {
    process.exitCode = 1;
    return;
  }

  const server = new McpServer({
    name: "triggerdev",
    version: "1.0.0",
    description: "Trigger.dev MCP server. Search the Trigger.dev docs.",
  });

  const fileLogger: FileLogger | undefined = options.logFile
    ? new FileLogger(options.logFile, server)
    : undefined;

  server.registerTool(
    "search_docs",
    {
      description:
        "Search across the Trigger.dev documentation to find relevant information, code examples, API references, and guides. Use this tool when you need to answer questions about Trigger.dev, find specific documentation, understand how features work, or locate implementation details. The search returns contextual content with titles and direct links to the documentation pages",
      inputSchema: {
        query: z.string(),
      },
    },
    async ({ query }) => {
      const results = await performSearch(query);
      return results;
    }
  );

  server.registerTool(
    "get_project_details",
    {
      description: "Get the details of the project",
      inputSchema: {
        projectRef: z.string().optional(),
      },
    },
    async ({ projectRef }, extra) => {
      const roots = await server.server.listRoots();

      fileLogger?.log("get_project_details", { roots, projectRef, extra });

      return {
        content: [{ type: "text", text: "Not implemented" }],
      };
    }
  );

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
