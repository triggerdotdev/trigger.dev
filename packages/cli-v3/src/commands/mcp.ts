import { intro, outro } from "@clack/prompts";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { VERSION } from "@trigger.dev/core";
import { tryCatch } from "@trigger.dev/core/utils";
import { Command, Option as CommandOption } from "commander";
import { z } from "zod";
import { CommonCommandOptions, commonOptions, wrapCommandAction } from "../cli/common.js";
import { CLOUD_API_URL } from "../consts.js";
import { McpContext } from "../mcp/context.js";
import { FileLogger } from "../mcp/logger.js";
import { registerTools } from "../mcp/tools.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { installMcpServer } from "./install-mcp.js";
import { serverMetadata } from "../mcp/config.js";
import { initiateRulesInstallWizard } from "./install-rules.js";

const McpCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  logFile: z.string().optional(),
  devOnly: z.boolean().default(false),
  envOnly: z.string().optional(),
  disableDeployment: z.boolean().default(false),
  readonly: z.boolean().default(false),
  rulesInstallManifestPath: z.string().optional(),
  rulesInstallBranch: z.string().optional(),
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
        "Only run the MCP server for the dev environment. Attempts to access other environments will fail. (Deprecated: use --env-only dev instead)"
      )
      .option(
        "--env-only <environments>",
        "Restrict the MCP server to specific environments only. Comma-separated list of: dev, staging, prod, preview. Example: --env-only dev,staging"
      )
      .option(
        "--disable-deployment",
        "Disable deployment-related tools. When enabled, deployment tools won't be available. This option is overridden by --readonly."
      )
      .option(
        "--readonly",
        "Run in read-only mode. Disables all write operations including deployments, task triggering, and project creation. Overrides --disable-deployment."
      )
      .option("--log-file <log file>", "The file to log to")
      .addOption(
        new CommandOption(
          "--rules-install-manifest-path <path>",
          "The path to the rules install manifest"
        ).hideHelp()
      )
      .addOption(
        new CommandOption(
          "--rules-install-branch <branch>",
          "The branch to install the rules from"
        ).hideHelp()
      )
  ).action(async (options) => {
    wrapCommandAction("mcp", McpCommandOptions, options, async (opts) => {
      await mcpCommand(opts);
    });
  });
}

export async function mcpCommand(options: McpCommandOptions) {
  if (process.stdout.isTTY) {
    await printStandloneInitialBanner(true);

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

    await initiateRulesInstallWizard({
      manifestPath: options.rulesInstallManifestPath,
      branch: options.rulesInstallBranch,
    });

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
  };

  // Start receiving messages on stdin and sending messages on stdout
  const transport = new StdioServerTransport();

  const fileLogger: FileLogger | undefined = options.logFile
    ? new FileLogger(options.logFile, server)
    : undefined;

  // Check for mutual exclusivity
  if (options.devOnly && options.envOnly) {
    logger.error("Error: --dev-only and --env-only are mutually exclusive. Please use only one.");
    process.exit(1);
  }

  // Parse envOnly into an array if provided
  let envOnly: string[] | undefined;
  if (options.envOnly) {
    envOnly = options.envOnly.split(',').map(env => env.trim());
  } else if (options.devOnly) {
    // For backward compatibility, convert devOnly to envOnly
    envOnly = ['dev'];
  }

  const context = new McpContext(server, {
    projectRef: options.projectRef,
    fileLogger,
    apiUrl: options.apiUrl ?? CLOUD_API_URL,
    profile: options.profile,
    devOnly: options.devOnly,
    envOnly,
    disableDeployment: options.disableDeployment,
    readonly: options.readonly,
  });

  registerTools(context);

  await server.connect(transport);
}
