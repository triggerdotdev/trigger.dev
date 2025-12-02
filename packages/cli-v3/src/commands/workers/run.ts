import { Command } from "commander";
import { printStandloneInitialBanner } from "../../utilities/initialBanner.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../../cli/common.js";
import { login } from "../login.js";
import { loadConfig } from "../../config.js";
import { resolve } from "path";
import { getProjectClient } from "../../utilities/session.js";
import { logger } from "../../utilities/logger.js";
import { z } from "zod";
import { env } from "std-env";
import { x } from "tinyexec";

const WorkersRunCommandOptions = CommonCommandOptions.extend({
  env: z.enum(["prod", "staging"]),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  token: z.string().default(env.TRIGGER_WORKER_TOKEN ?? ""),
  network: z.enum(["default", "none", "host"]).default("default"),
});
type WorkersRunCommandOptions = z.infer<typeof WorkersRunCommandOptions>;

export function configureWorkersRunCommand(program: Command) {
  return commonOptions(
    program
      .command("run")
      .description("Runs a worker locally")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-e, --env <env>",
        "Deploy to a specific environment (currently only prod and staging are supported)",
        "prod"
      )
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .option("-t, --token <token>", "The worker token to use for authentication")
      .option("--network <mode>", "The networking mode for the container", "host")
      .action(async (path, options) => {
        await handleTelemetry(async () => {
          await printStandloneInitialBanner(true, options.profile);
          await workersRunCommand(path, options);
        });
      })
  );
}

async function workersRunCommand(dir: string, options: unknown) {
  return await wrapCommandAction(
    "workerRunCommand",
    WorkersRunCommandOptions,
    options,
    async (opts) => {
      return await _workersRunCommand(dir, opts);
    }
  );
}

async function _workersRunCommand(dir: string, options: WorkersRunCommandOptions) {
  if (!options.token) {
    throw new Error(
      "You must provide a worker token to run a worker locally. Either use the `--token` flag or set the `TRIGGER_WORKER_TOKEN` environment variable."
    );
  }

  logger.log("Running worker locally");

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    if (authorization.error === "fetch failed") {
      throw new Error(
        `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
      );
    } else {
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
  }

  const projectPath = resolve(process.cwd(), dir);

  const resolvedConfig = await loadConfig({
    cwd: projectPath,
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const deployment = await projectClient.client.deployments.unmanaged.latest();

  if (!deployment.success) {
    throw new Error("Failed to get latest deployment");
  }

  const { version, imageReference } = deployment.data;

  if (!imageReference) {
    throw new Error("No image reference found for the latest deployment");
  }

  logger.log(`Version ${version}`);
  logger.log(`Image: ${imageReference}`);

  const command = "docker";
  const args = [
    "run",
    "--rm",
    "--network",
    options.network,
    "-e",
    `TRIGGER_WORKER_TOKEN=${options.token}`,
    "-e",
    `TRIGGER_API_URL=${authorization.auth.apiUrl}`,
    imageReference,
  ];

  logger.debug(`Command: ${command} ${args.join(" ")}`);
  logger.log(); // spacing

  const proc = x("docker", args);

  for await (const line of proc) {
    logger.log(line);
  }
}
