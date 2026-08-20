import { intro, outro } from "@clack/prompts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "@trigger.dev/core";
import { tryCatch } from "@trigger.dev/core/utils";
import type { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { serverMetadata } from "../mcp/config.js";
import { McpContext } from "../mcp/context.js";
import { toMcpContextOptions } from "../mcp/contextOptions.js";
import { FileLogger } from "../mcp/logger.js";
import { registerPrompts } from "../mcp/prompts.js";
import { registerTools } from "../mcp/tools.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { installMcpServer } from "./install-mcp.js";
import { initiateSkillsInstallWizard } from "./skills.js";

const McpCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  logFile: z.string().optional(),
  devOnly: z.boolean().default(false),
  readonly: z.boolean().default(false),
  install: z.boolean().default(false),
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
      .option(
        "--readonly",
        "Run in read-only mode. Write tools (deploy, trigger_task, cancel_run) are hidden from the AI."
      )
      .option("--log-file <log file>", "The file to log to")
      .option(
        "--install",
        "Run the interactive install wizard instead of starting the server. Bare `mcp` always starts the server (so clients that spawn it over a PTY don't get stuck in the wizard)."
      )
  ).action(async (options) => {
    wrapCommandAction("mcp", McpCommandOptions, options, async (opts) => {
      await mcpCommand(opts);
    });
  });
}

async function mcpCommand(options: McpCommandOptions) {
  // The install wizard runs ONLY when explicitly requested (`trigger mcp --install`).
  // Bare `trigger mcp` always starts the server — MCP hosts (e.g. Claude Code) spawn it
  // over a PTY, so `process.stdout.isTTY` is true even though no human is there; gating
  // the wizard on isTTY made the server never start and the client time out.
  if (options.install) {
    await printStandloneInitialBanner(true, options.profile);

    intro("Welcome to the Trigger.dev MCP server install wizard 🧙");

    const [installError] = await tryCatch(
      installMcpServer({
        yolo: false,
        tag: VERSION as string,
        logLevel: "log",
      })
    );

    if (installError) {
      outro(`Failed to install MCP server: ${installError.message}`);
      return;
    }

    await initiateSkillsInstallWizard({});

    return;
  }

  logger.loggerLevel = "none";

  const server = new McpServer(
    {
      name: serverMetadata.name,
      version: serverMetadata.version,
    },
    {
      instructions: serverMetadata.instructions,
    }
  );

  server.server.oninitialized = async () => {
    fileLogger?.log("initialized mcp command", { options, argv: process.argv });
    await context.loadProjectProfile();
  };

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();

  const fileLogger: FileLogger | undefined = options.logFile
    ? new FileLogger(options.logFile, server)
    : undefined;

  const context = new McpContext(server, toMcpContextOptions(options, fileLogger));

  registerTools(context);
  registerPrompts(context);

  await server.connect(transport);
}
