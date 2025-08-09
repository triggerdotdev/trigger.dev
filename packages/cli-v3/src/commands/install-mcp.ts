import { intro, isCancel, multiselect, select, spinner, log, outro } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import { OutroCommandError, wrapCommandAction } from "../cli/common.js";
import { expandTilde, safeReadJSONFile, writeJSONFile } from "../utilities/fileSystem.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { VERSION } from "../version.js";
import chalk from "chalk";
import { cliLink } from "../utilities/cliOutput.js";

const cliVersion = VERSION as string;
const cliTag = cliVersion.includes("v4-beta") ? "v4-beta" : "latest";

const clients = [
  "claude-code",
  "cursor",
  "vscode",
  "windsurf",
  "gemini-cli",
  "crush",
  "cline",
] as const;
const scopes = ["user", "project", "local"] as const;

type ClientScopes = {
  [key in (typeof clients)[number]]: {
    [key in (typeof scopes)[number]]?: string;
  };
};

const clientScopes: ClientScopes = {
  "claude-code": {
    user: "~/.claude.json",
    project: "./.mcp.json",
    local: "~/.claude.json",
  },
  cursor: {
    user: "~/.cursor/mcp.json",
    project: "./.cursor/mcp.json",
  },
  vscode: {
    user: "~/Library/Application Support/Code/User/mcp.json",
    project: "./.vscode/mcp.json",
  },
  windsurf: {
    user: "~/.codeium/windsurf/mcp_config.json",
  },
  "gemini-cli": {
    user: "~/.gemini/settings.json",
    project: "./.gemini/settings.json",
  },
  crush: {
    user: "~/.config/crush/crush.json",
    project: "./crush.json",
    local: "./.crush.json",
  },
  cline: {
    user: "~/Library/Application Support/Code/User/globalStorage/saoudrizwan.claude-dev/settings/cline_mcp_settings.json",
  },
};

const InstallMcpCommandOptions = z.object({
  projectRef: z.string().optional(),
  tag: z.string().default(cliVersion),
  devOnly: z.boolean().default(false),
  yolo: z.boolean().default(false),
  scope: z.enum(scopes).optional(),
  client: z.enum(clients).array().optional(),
  logFile: z.string().optional(),
  apiUrl: z.string().optional(),
  logLevel: z.enum(["debug", "info", "log", "warn", "error", "none"]).default("log"),
});

type InstallMcpCommandOptions = z.infer<typeof InstallMcpCommandOptions>;

export function configureInstallMcpCommand(program: Command) {
  return program
    .command("install-mcp")
    .description("Install the Trigger.dev MCP server")
    .option(
      "-p, --project-ref <project ref>",
      "Scope the mcp server to a specific Trigger.dev project by providing its project ref"
    )
    .option(
      "-t, --tag <package tag>",
      "The version of the trigger.dev CLI package to use for the MCP server",
      cliTag
    )
    .option("--dev-only", "Restrict the MCP server to the dev environment only")
    .option("--yolo", "Install the MCP server into all supported clients")
    .option("--scope <scope>", "Choose the scope of the MCP server, either user or project")
    .option(
      "--client <clients...>",
      "Choose the client (or clients) to install the MCP server into"
    )
    .option("--log-file <log file>", "Configure the MCP server to write logs to a file")
    .option(
      "-a, --api-url <value>",
      "Configure the MCP server to specify a custom Trigger.dev API URL"
    )
    .option(
      "-l, --log-level <level>",
      "The CLI log level to use (debug, info, log, warn, error, none). This does not effect the log level of your trigger.dev tasks.",
      "log"
    )
    .action(async (options) => {
      await printStandloneInitialBanner(true);
      await installMcpCommand(options);
    });
}

export async function installMcpCommand(options: unknown) {
  return await wrapCommandAction(
    "installMcpCommand",
    InstallMcpCommandOptions,
    options,
    async (opts) => {
      return await _installMcpCommand(opts);
    }
  );
}

async function _installMcpCommand(options: InstallMcpCommandOptions) {
  intro("Installing Trigger.dev MCP server");

  const results = await installMcpServer(options);

  if (results.length > 0) {
    log.step("Installed to:");
    for (const r of results) {
      const scopeLabel = `${r.scope.scope}`;
      log.message(`  • ${r.clientName} (${scopeLabel}) → ${chalk.gray(r.configPath)}`);
    }
  }

  log.info("Next steps:");
  log.message("  1. Restart your MCP client(s) to load the new configuration.");
  log.message(
    '  2. In your client, look for a server named "trigger". It should connect automatically.'
  );
  log.message("  3. Get started with Trigger.dev");
  log.message(
    `     Try asking your vibe-coding friend to ${chalk.green("Add trigger.dev to my project")}`
  );

  log.info("More examples:");
  log.message(`  • ${chalk.green('"List my Trigger.dev projects"')}`);
  log.message(`  • ${chalk.green('"Create a new Trigger.dev project called MyApp"')}`);
  log.message(`  • ${chalk.green('"Show me all tasks in my project"')}`);
  log.message(`  • ${chalk.green('"Trigger the email-notification task"')}`);
  log.message(`  • ${chalk.green('"How do I create a scheduled task in Trigger.dev?"')}`);
  log.message(`  • ${chalk.green('"Search Trigger.dev docs for webhook examples"')}`);

  log.info("Helpful links:");
  log.message(`  • ${cliLink("Trigger.dev docs", "https://trigger.dev/docs")}`);
  log.message(`  • ${cliLink("MCP docs", "https://trigger.dev/docs/mcp")}`);
  log.message(
    `  • Need help? ${cliLink(
      "Join our Discord",
      "https://trigger.dev/discord"
    )} or email help@trigger.dev`
  );

  outro(`MCP Server ready to go!`);
}

type InstallMcpServerResults = Array<InstallMcpServerResult>;

type InstallMcpServerResult = {
  configPath: string;
  clientName: (typeof clients)[number];
  scope: McpServerScope;
};

export async function installMcpServer(
  options: InstallMcpCommandOptions
): Promise<InstallMcpServerResults> {
  const clientNames = await resolveClients(options);

  const results = [];

  for (const clientName of clientNames) {
    const result = await installMcpServerForClient(clientName, options);

    results.push(result);
  }

  return results;
}

async function installMcpServerForClient(
  clientName: (typeof clients)[number],
  options: InstallMcpCommandOptions
) {
  const clientSpinner = spinner({ indicator: "dots" });

  clientSpinner.start(`Installing in ${clientName}`);

  const scope = await resolveScopeForClient(clientName, options);

  clientSpinner.message(`Installing in ${scope.scope} scope at ${scope.location}`);

  const configPath = await performInstallForClient(clientName, scope, options);

  clientSpinner.stop(`Successfully installed in ${clientName} (${configPath})`);

  return { configPath, clientName, scope };
}

type McpServerConfig = Record<string, string | Array<string> | undefined>;
type McpServerScope = {
  scope: (typeof scopes)[number];
  location: string;
};

async function performInstallForClient(
  clientName: (typeof clients)[number],
  scope: McpServerScope,
  options: InstallMcpCommandOptions
) {
  const config = resolveMcpServerConfig(clientName, options);
  const pathComponents = resolveMcpServerConfigJsonPath(clientName, scope);

  return await writeMcpServerConfig(scope.location, pathComponents, config);
}

async function writeMcpServerConfig(
  location: string,
  pathComponents: string[],
  config: McpServerConfig
) {
  const fullPath = expandTilde(location);

  let existingConfig = await safeReadJSONFile(fullPath);

  if (!existingConfig) {
    existingConfig = {};
  }

  const newConfig = applyConfigToExistingConfig(existingConfig, pathComponents, config);

  await writeJSONFile(fullPath, newConfig, true);

  return fullPath;
}

function applyConfigToExistingConfig(
  existingConfig: any,
  pathComponents: string[],
  config: McpServerConfig
) {
  const clonedConfig = structuredClone(existingConfig);

  let currentValueAtPath = clonedConfig;

  for (let i = 0; i < pathComponents.length; i++) {
    const currentPathSegment = pathComponents[i];

    if (!currentPathSegment) {
      break;
    }

    if (i === pathComponents.length - 1) {
      currentValueAtPath[currentPathSegment] = config;
      break;
    } else {
      currentValueAtPath[currentPathSegment] = currentValueAtPath[currentPathSegment] || {};
      currentValueAtPath = currentValueAtPath[currentPathSegment];
    }
  }

  return clonedConfig;
}

function resolveMcpServerConfigJsonPath(
  clientName: (typeof clients)[number],
  scope: McpServerScope
) {
  switch (clientName) {
    case "cursor": {
      return ["mcpServers", "trigger"];
    }
    case "vscode": {
      return ["servers", "trigger"];
    }
    case "crush": {
      return ["mcp", "trigger"];
    }
    case "windsurf": {
      return ["mcpServers", "trigger"];
    }
    case "gemini-cli": {
      return ["mcpServers", "trigger"];
    }
    case "cline": {
      return ["mcpServers", "trigger"];
    }
    case "claude-code": {
      if (scope.scope === "local") {
        const projectPath = process.cwd();

        return ["projects", projectPath, "mcpServers", "trigger"];
      } else {
        return ["mcpServers", "trigger"];
      }
    }
  }
}

function resolveMcpServerConfig(
  clientName: (typeof clients)[number],
  options: InstallMcpCommandOptions
): McpServerConfig {
  const args = [`trigger.dev@${options.tag}`, "mcp"];

  if (options.logFile) {
    args.push("--log-file", options.logFile);
  }

  if (options.apiUrl) {
    args.push("--api-url", options.apiUrl);
  }

  if (options.devOnly) {
    args.push("--dev-only");
  }

  if (options.projectRef) {
    args.push("--project-ref", options.projectRef);
  }

  switch (clientName) {
    case "claude-code": {
      return {
        command: "npx",
        args,
      };
    }
    case "cursor": {
      return {
        command: "npx",
        args,
      };
    }
    case "vscode": {
      return {
        command: "npx",
        args,
      };
    }
    case "crush": {
      return {
        type: "stdio",
        command: "npx",
        args,
      };
    }
    case "windsurf": {
      return {
        command: "npx",
        args,
      };
    }
    case "gemini-cli": {
      return {
        command: "npx",
        args,
      };
    }
    case "cline": {
      return {
        command: "npx",
        args,
      };
    }
  }
}

async function resolveScopeForClient(
  clientName: (typeof clients)[number],
  options: InstallMcpCommandOptions
) {
  if (options.scope) {
    const location = clientScopes[clientName][options.scope];

    if (!location) {
      throw new OutroCommandError(
        `The ${clientName} client does not support the ${
          options.scope
        } scope, it only supports ${Object.keys(clientScopes[clientName]).join(", ")} scopes`
      );
    }

    return {
      scope: options.scope,
      location,
    };
  }

  const scopeOptions = resolveScopeOptionsForClient(clientName);

  const selectedScope = await select({
    message: `Where should the MCP server for ${clientName} be installed?`,
    options: scopeOptions,
  });

  if (isCancel(selectedScope)) {
    throw new OutroCommandError("No scope selected");
  }

  return selectedScope;
}

function resolveScopeOptionsForClient(clientName: (typeof clients)[number]): Array<{
  value: { location: string; scope: (typeof scopes)[number] };
  label: string;
  hint: string;
}> {
  const $clientScopes = clientScopes[clientName];

  const options = Object.entries($clientScopes).map(([scope, location]) => ({
    value: { location, scope: scope as (typeof scopes)[number] },
    label: scope,
    hint: scopeHint(scope as (typeof scopes)[number], location),
  }));

  return options;
}

function scopeHint(scope: (typeof scopes)[number], location: string) {
  switch (scope) {
    case "user": {
      return `Install for your user account on your machine (${location})`;
    }
    case "project": {
      return `Install in the current project shared with your team (${location})`;
    }
    case "local": {
      return `Install in the current project, local to you only (${location})`;
    }
  }
}

async function resolveClients(
  options: InstallMcpCommandOptions
): Promise<(typeof clients)[number][]> {
  if (options.client) {
    return options.client;
  }

  if (options.yolo) {
    return [...clients];
  }

  const selectedClients = await multiselect({
    message: "Select one or more clients to install the MCP server into",
    options: clients.map((client) => ({
      value: client,
      label: client,
    })),
    required: true,
  });

  if (isCancel(selectedClients)) {
    throw new OutroCommandError("No clients selected");
  }

  return selectedClients;
}
