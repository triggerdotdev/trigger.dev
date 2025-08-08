import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { CLOUD_API_URL } from "../consts.js";
import { McpContext } from "../mcp/context.js";
import { FileLogger } from "../mcp/logger.js";
import {
  registerCreateProjectTool,
  registerGetTasksTool,
  registerInitializeProjectTool,
  registerListOrgsTool,
  registerListProjectsTool,
  registerSearchDocsTool,
  registerTriggerTaskTool,
} from "../mcp/tools.js";
import { logger } from "../utilities/logger.js";

const McpCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  logFile: z.string().optional(),
  devOnly: z.boolean().default(false),
});

export type McpCommandOptions = z.infer<typeof McpCommandOptions>;

export function configureMcpCommand(program: Command) {
  return commonOptions(
    program
      .command("mcp")
      .description("Run the MCP server")
      .option("-p, --project-ref <project ref>", "The project ref to use")
      .option(
        "--dev-only",
        "Only run the MCP server for the dev environment. Attempts to access other environments will fail."
      )
      .option("--log-file <log file>", "The file to log to")
  ).action(async (options) => {
    wrapCommandAction("mcp", McpCommandOptions, options, async (opts) => {
      await mcpCommand(opts);
    });
  });
}

export async function mcpCommand(options: McpCommandOptions) {
  logger.loggerLevel = "none";

  const server = new McpServer({
    name: "triggerdev",
    version: "1.0.0",
    description:
      "Trigger.dev MCP server to automate your Trigger.dev projects and answer questions about Trigger.dev by searching the docs. If you need help setting up Trigger.dev in your project please refer to https://trigger.dev/docs/manual-setup. If the user asks for help with adding Trigger.dev to their project, please refer to https://trigger.dev/docs/manual-setup.",
  });

  server.server.oninitialized = async () => {
    fileLogger?.log("initialized mcp command", { options, argv: process.argv, env: process.env });
  };

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();

  const fileLogger: FileLogger | undefined = options.logFile
    ? new FileLogger(options.logFile, server)
    : undefined;

  const context = new McpContext(server, {
    projectRef: options.projectRef,
    fileLogger,
    apiUrl: options.apiUrl ?? CLOUD_API_URL,
    profile: options.profile,
  });

  registerSearchDocsTool(context);
  registerInitializeProjectTool(context);
  registerGetTasksTool(context);
  registerTriggerTaskTool(context);
  registerListProjectsTool(context);
  registerListOrgsTool(context);
  registerCreateProjectTool(context);

  await server.connect(transport);
}
