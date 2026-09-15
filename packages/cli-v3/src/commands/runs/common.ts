import type { Command } from "commander";
import { z } from "zod";
import { CommonCommandOptions } from "../../cli/common.js";
import { loadConfig } from "../../config.js";
import { logger } from "../../utilities/logger.js";
import { getProjectEnvApiClient } from "../../utilities/session.js";
import { login } from "../login.js";

export const RunsCommonOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  env: z.enum(["dev", "prod", "staging", "preview", "production"]).default("prod"),
  branch: z.string().optional(),
});

export type RunsCommonOptions = z.infer<typeof RunsCommonOptions>;

export function runsOptions(command: Command) {
  return command
    .option("-c, --config <config file>", "The name of the config file")
    .option(
      "-p, --project-ref <project ref>",
      "The project ref. Required if there is no config file"
    )
    .option("-e, --env <env>", "The environment to use (dev, prod, staging, preview)", "prod")
    .option("-b, --branch <branch>", "The preview branch when using --env preview");
}

/** Resolves the project + environment and returns a core API client scoped to it. */
export async function resolveRunsClient(options: RunsCommonOptions) {
  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
    silent: true,
  });

  if (!authorization.ok) {
    throw new Error(
      `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
    );
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

  const apiClient = await getProjectEnvApiClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env,
    branch: options.branch,
    profile: options.profile,
  });

  if (!apiClient) {
    throw new Error("Failed to get project client");
  }

  return { apiClient, projectRef: resolvedConfig.project, env, branch: options.branch };
}

export function formatEnvInfo(env: string, branch: string | undefined) {
  return branch ? `${env} (${branch})` : env;
}
