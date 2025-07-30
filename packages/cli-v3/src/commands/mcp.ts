import { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { chalkError } from "../utilities/cliOutput.js";
import { logger } from "../utilities/logger.js";
import { login } from "./login.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";

const McpCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  mcpPort: z.coerce.number().optional().default(3333),
});

export type McpCommandOptions = z.infer<typeof McpCommandOptions>;

export function configureMcpCommand(program: Command) {
  return commonOptions(
    program
      .command("mcp")
      .description("Run the MCP server")
      .option("-p, --project-ref <project ref>", "The project ref to use")
      .option("-m, --mcp-port <port>", "The port to run the MCP server on", "3333")
  ).action(async (options) => {
    wrapCommandAction("mcp", McpCommandOptions, options, async (opts) => {
      await mcpCommand(opts);
    });
  });
}

export async function mcpCommand(options: McpCommandOptions) {
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
    name: "trigger.dev",
    version: "1.0.0",
  });

  server.registerTool(
    "get_project_details",
    {
      title: "Get Project Details",
      description: "Get the details of the project",
      inputSchema: {
        cwd: z.string().describe("The current working directory the user is in"),
      },
    },
    async ({ cwd }) => {
      return {
        content: [{ type: "text", text: `Current working directory: ${cwd}` }],
      };
    }
  );

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
