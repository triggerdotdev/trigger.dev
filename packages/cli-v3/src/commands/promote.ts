import { intro, outro } from "@clack/prompts";
import { Command } from "commander";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient } from "../utilities/session.js";
import { login } from "./login.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { getBranch } from "@trigger.dev/core/v3";

const PromoteCommandOptions = CommonCommandOptions.extend({
  projectRef: z.string().optional(),
  apiUrl: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
  config: z.string().optional(),
  env: z.enum(["prod", "staging", "preview"]),
  branch: z.string().optional(),
});

type PromoteCommandOptions = z.infer<typeof PromoteCommandOptions>;

export function configurePromoteCommand(program: Command) {
  return commonOptions(
    program
      .command("promote")
      .description("Promote a previously deployed version to the current deployment")
      .argument("[version]", "The version to promote")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-e, --env <env>",
        "Deploy to a specific environment (currently only prod and staging are supported)",
        "prod"
      )
      .option(
        "-b, --branch <branch>",
        "The preview branch to promote when passing --env preview. If not provided, we'll detect your git branch."
      )
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
  ).action(async (version, options) => {
    await handleTelemetry(async () => {
      await printStandloneInitialBanner(true);
      await promoteCommand(version, options);
    });
  });
}

export async function promoteCommand(version: string, options: unknown) {
  return await wrapCommandAction("promoteCommand", PromoteCommandOptions, options, async (opts) => {
    return await _promoteCommand(version, opts);
  });
}

async function _promoteCommand(version: string, options: PromoteCommandOptions) {
  if (!version) {
    throw new Error(
      "You must provide a version to promote like so: `npx trigger.dev@latest promote 20250208.1`"
    );
  }

  intro(`Promoting version ${version}`);

  const authorization = await login({
    embedded: true,
    defaultApiUrl: options.apiUrl,
    profile: options.profile,
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

  const resolvedConfig = await loadConfig({
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const branch =
    options.env === "preview" ? getBranch({ specified: options.branch, gitMeta }) : undefined;
  if (options.env === "preview" && !branch) {
    throw new Error(
      "Didn't auto-detect preview branch, so you need to specify one. Pass --branch <branch>."
    );
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: options.env,
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const promotion = await projectClient.client.promoteDeployment(version);

  if (!promotion.success) {
    throw new Error(promotion.error);
  }

  outro(`Promoted version ${version}`);
}
