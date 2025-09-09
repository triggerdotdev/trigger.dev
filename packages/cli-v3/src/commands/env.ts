import { Command } from "commander";
import { z } from "zod";
import { printInitialBanner } from "../utilities/initialBanner.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { intro, outro, log, confirm, isCancel } from "@clack/prompts";
import chalk from "chalk";
import Table from "cli-table3";
import { logger } from "../utilities/logger.js";
import { login } from "./login.js";
import { getProjectClient, upsertBranch } from "../utilities/session.js";
import { loadConfig } from "../config.js";
import { spinner } from "../utilities/windows.js";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { tryCatch } from "@trigger.dev/core";

const EnvListOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  showValues: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview", "production"]).default("prod"),
  branch: z.string().optional(),
});

const EnvGetOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  name: z.string(),
  raw: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview", "production"]).default("prod"),
  branch: z.string().optional(),
});

const EnvPullOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  output: z.string().default(".env.local"),
  force: z.boolean().default(false),
  env: z.enum(["prod", "staging", "preview", "production"]).default("prod"),
  branch: z.string().optional(),
});

export function configureEnvCommand(program: Command) {
  const envCommand = program
    .command("env")
    .description("Manage environment variables for your Trigger.dev project");

  commonOptions(
    envCommand
      .command("list")
      .description("List all environment variables for your project")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file."
      )
      .option(
        "-e, --env <env>",
        "The environment to list variables from (prod, staging, preview)",
        "prod"
      )
      .option("-b, --branch <branch>", "The preview branch when using --env preview")
      .option(
        "--show-values",
        "Show the actual values of environment variables, including secret values"
      )
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false);
      await envListCommand(options);
    });
  });

  commonOptions(
    envCommand
      .command("get <name>")
      .description("Get the value of a specific environment variable")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file"
      )
      .option(
        "-e, --env <env>",
        "The environment to get the variable from (prod, staging, preview)",
        "prod"
      )
      .option("-b, --branch <branch>", "The preview branch when using --env preview")
      .option("--raw", "Only output the raw value without any formatting or additional information")
  ).action(async (name, options) => {
    await handleTelemetry(async () => {
      if (!options.raw) {
        await printInitialBanner(false);
      }
      await envGetCommand({ ...options, name });
    });
  });

  commonOptions(
    envCommand
      .command("pull")
      .description("Pull environment variables from your project to a local file")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file"
      )
      .option(
        "-e, --env <env>",
        "The environment to pull variables from (prod, staging, preview)",
        "prod"
      )
      .option("-b, --branch <branch>", "The preview branch when using --env preview")
      .option("-o, --output <file>", "Output file path", ".env.local")
      .option("--force", "Overwrite the output file if it exists")
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false);
      await envPullCommand(options);
    });
  });

  return envCommand;
}

async function envListCommand(options: unknown) {
  return await wrapCommandAction(
    "envList",
    EnvListOptions,
    options,
    async (opts: z.infer<typeof EnvListOptions>) => {
      return await _envListCommand(opts);
    }
  );
}

async function envGetCommand(options: unknown) {
  return await wrapCommandAction(
    "envGet",
    EnvGetOptions,
    options,
    async (opts: z.infer<typeof EnvGetOptions>) => {
      return await _envGetCommand(opts);
    }
  );
}

async function envPullCommand(options: unknown) {
  return await wrapCommandAction(
    "envPull",
    EnvPullOptions,
    options,
    async (opts: z.infer<typeof EnvPullOptions>) => {
      return await _envPullCommand(opts);
    }
  );
}

async function resolveProjectEnv(
  options:
    | z.infer<typeof EnvListOptions>
    | z.infer<typeof EnvGetOptions>
    | z.infer<typeof EnvPullOptions>
) {
  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: "raw" in options ? options.raw : false,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    }

    throw new Error(`You must login first. Use the \`login\` CLI command.`);
  }

  const resolvedConfig = await loadConfig({
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  // Coerce production to prod
  const env = options.env === "production" ? "prod" : options.env;

  if (env === "preview" && !options.branch) {
    throw new Error("Missing branch for the preview environment.");
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env,
    branch: options.branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  return {
    projectClient,
    projectRef: resolvedConfig.project,
    env,
    branch: options.branch,
  };
}

async function _envListCommand(options: z.infer<typeof EnvListOptions>) {
  intro("Environment Variables");

  const $spinner = spinner();

  const { projectClient, projectRef, env, branch } = await resolveProjectEnv(options);

  $spinner.start("Loading environment variables from project");
  const envVars = await projectClient.client.getEnvironmentVariables(projectRef);

  if (!envVars.success) {
    $spinner.stop("Failed loading environment variables");
    throw envVars.error;
  }

  $spinner.stop("Environment variables loaded");

  const variables = envVars.data.variables;

  // Filter out TRIGGER_ system variables to only show user-set variables.
  // The current envvars endpoint doesn't support filtering, so we just do basic filtering on the client side.
  // We'll soon add a v2 of this endpoint which supports filtering and also includes more info about the variables.
  const userVariables = Object.entries(variables).filter(([key]) => !key.startsWith("TRIGGER_"));

  if (userVariables.length === 0) {
    log.info("No environment variables found");
    const envInfo = branch ? `${env} (${branch})` : env;
    outro(`Project: ${projectRef} | Environment: ${envInfo}`);
    return;
  }

  const table = new Table({
    head: ["Variable", options.showValues ? "Value" : "Value (hidden)"],
    style: {
      head: ["yellow"],
    },
    chars: {
      top: "",
      "top-mid": "",
      "top-left": "",
      "top-right": "",
      bottom: "",
      "bottom-mid": "",
      "bottom-left": "",
      "bottom-right": "",
      left: "",
      "left-mid": "",
      mid: "",
      "mid-mid": "",
      right: "",
      "right-mid": "",
      middle: " ",
    },
  });

  for (const [key, value] of userVariables) {
    table.push([key, options.showValues ? value : "******"]);
  }

  console.log();
  console.log(table.toString());
  console.log();

  if (!options.showValues) {
    log.info(chalk.dim("Use --show-values to display the actual values"));
  }

  const envInfo = branch ? `${env} (${branch})` : env;
  outro(
    `Found ${userVariables.length} environment variable${
      userVariables.length === 1 ? "" : "s"
    } | Project: ${projectRef} | Environment: ${envInfo}`
  );
}

async function _envGetCommand(options: z.infer<typeof EnvGetOptions>) {
  const $spinner = options.raw ? null : spinner();

  if (!options.raw) {
    intro(`Getting environment variable: ${options.name}`);
  }

  const { projectClient, projectRef, env, branch } = await resolveProjectEnv(options);

  $spinner?.start("Loading environment variables from project");
  const envVars = await projectClient.client.getEnvironmentVariables(projectRef);

  if (!envVars.success) {
    $spinner?.stop("Failed loading environment variables");
    throw new Error(`Failed to load environment variables: ${envVars.error}`);
  }

  $spinner?.stop("Environment variables loaded");

  const variables = envVars.data.variables;

  const value = variables[options.name];

  if (value === undefined) {
    if (options.raw) {
      throw new Error(`Environment variable "${options.name}" not found`);
    }

    log.error(chalk.red(`Environment variable '${options.name}' not found`));

    // Suggest similar variables if any exist
    const keys = Object.keys(variables);
    const similar = keys.filter(
      (k: string) =>
        k.toLowerCase().includes(options.name.toLowerCase()) ||
        options.name.toLowerCase().includes(k.toLowerCase())
    );

    if (similar.length > 0) {
      log.info(chalk.dim("Did you mean one of these?"));
      similar.forEach((s: string) => log.info(chalk.dim(`  - ${s}`)));
    }

    const envInfo = branch ? `${env} (${branch})` : env;
    outro(`Project: ${projectRef} | Environment: ${envInfo}`);
    process.exit(1);
  }

  if (options.raw) {
    console.log(value || "");
    return;
  }

  log.success(chalk.green(`${options.name}=${value}`));

  const envInfo = branch ? `${env} (${branch})` : env;
  outro(`Project: ${projectRef} | Environment: ${envInfo}`);
}

async function _envPullCommand(options: z.infer<typeof EnvPullOptions>) {
  intro("Pull Environment Variables");
  const $spinner = spinner();

  const { projectClient, projectRef, env, branch } = await resolveProjectEnv(options);

  $spinner.start("Loading environment variables from project");

  const envVars = await projectClient.client.getEnvironmentVariables(projectRef);

  if (!envVars.success) {
    $spinner.stop("Failed loading environment variables");
    throw envVars.error;
  }

  $spinner.stop("Environment variables loaded");

  const variables = envVars.data.variables;
  // Filter out TRIGGER_ system variables to only show user-set variables.
  // The current envvars endpoint doesn't support filtering, so we just do basic filtering on the client side.
  // We'll soon add a v2 of this endpoint which supports filtering and also includes more info about the variables.
  const userVariables = Object.entries(variables).filter(([key]) => !key.startsWith("TRIGGER_"));

  if (userVariables.length === 0) {
    log.info("No environment variables found");
    const envInfo = branch ? `${env} (${branch})` : env;
    outro(`Project: ${projectRef} | Environment: ${envInfo}`);
    return;
  }

  const outputPath = resolve(process.cwd(), options.output);

  const [error] = await tryCatch(writeFile(outputPath, "", { flag: "wx", mode: 0o600 }));

  if (error && "code" in error && error.code !== "EEXIST") {
    throw error;
  }

  if (error && "code" in error && error.code === "EEXIST" && !options.force) {
    const shouldOverwrite = await confirm({
      message: `File ${options.output} already exists. Overwrite?`,
      initialValue: false,
    });

    if (isCancel(shouldOverwrite) || !shouldOverwrite) {
      outro("Cancelled");
      return;
    }
  }

  const envContent = userVariables.map(([key, value]) => `${key}=${value || ""}`).join("\n");

  $spinner.start(`Writing to ${options.output}`);
  const [writeError] = await tryCatch(
    writeFile(outputPath, envContent + "\n", { encoding: "utf-8", mode: 0o600 })
  );

  if (writeError) {
    $spinner.stop(`Failed to write to ${options.output}`);
    throw writeError;
  }

  $spinner.stop(`Written to ${options.output}`);

  log.success(
    chalk.green(
      `Pulled ${userVariables.length} environment variable${
        userVariables.length === 1 ? "" : "s"
      } into ${options.output}`
    )
  );

  const envInfo = branch ? `${env} (${branch})` : env;
  outro(`Project: ${projectRef} | Environment: ${envInfo}`);
}
