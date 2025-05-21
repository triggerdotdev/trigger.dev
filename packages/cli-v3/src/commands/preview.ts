import { intro, log, outro } from "@clack/prompts";
import { getBranch, prepareDeploymentError } from "@trigger.dev/core/v3";
import { InitializeDeploymentResponseBody } from "@trigger.dev/core/v3/schemas";
import { Command, Option as CommandOption } from "commander";
import { resolve } from "node:path";
import { x } from "tinyexec";
import { z } from "zod";
import { isCI } from "std-env";
import { CliApiClient } from "../apiClient.js";
import { buildWorker } from "../build/buildWorker.js";
import { resolveAlwaysExternal } from "../build/externals.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  SkipLoggingError,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { buildImage } from "../deploy/buildImage.js";
import {
  checkLogsForErrors,
  checkLogsForWarnings,
  printErrors,
  printWarnings,
  saveLogs,
} from "../deploy/logs.js";
import { chalkError, cliLink, isLinksSupported, prettyError } from "../utilities/cliOutput.js";
import { loadDotEnvVars } from "../utilities/dotEnv.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient, upsertBranch } from "../utilities/session.js";
import { getTmpDir } from "../utilities/tempDirectories.js";
import { spinner } from "../utilities/windows.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";
import { setGithubActionsOutputAndEnvVars } from "../utilities/githubActions.js";
import { isDirectory } from "../utilities/fileSystem.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { verifyDirectory } from "./deploy.js";

const PreviewCommandOptions = CommonCommandOptions.extend({
  branch: z.string().optional(),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
  envFile: z.string().optional(),
});

type PreviewCommandOptions = z.infer<typeof PreviewCommandOptions>;

export function configureDeployCommand(program: Command) {
  return commonOptions(
    program
      .command("preview archive")
      .description("Archive a preview branch")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-b, --branch <branch>",
        "The preview branch to deploy to when passing --env preview. If not provided, we'll detect your local git branch."
      )
      .option("--skip-update-check", "Skip checking for @trigger.dev package updates")
      .option("-c, --config <config file>", "The name of the config file, found at [path]")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. Required if there is no config file. This will override the project specified in the config file."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
      )
  ).action(async (path, options) => {
    await handleTelemetry(async () => {
      await printStandloneInitialBanner(true);
      await previewArchiveCommand(path, options);
    });
  });
}

export async function previewArchiveCommand(dir: string, options: unknown) {
  return await wrapCommandAction(
    "previewArchiveCommand",
    PreviewCommandOptions,
    options,
    async (opts) => {
      return await _previewArchiveCommand(dir, opts);
    }
  );
}

async function _previewArchiveCommand(dir: string, options: PreviewCommandOptions) {
  intro(`Archiving preview branch`);

  if (!options.skipUpdateCheck) {
    await updateTriggerPackages(dir, { ...options }, true, true);
  }

  const cwd = process.cwd();
  const projectPath = resolve(cwd, dir);

  verifyDirectory(dir, projectPath);

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
    cwd: projectPath,
    overrides: { project: options.projectRef },
    configFile: options.config,
  });

  logger.debug("Resolved config", resolvedConfig);

  const gitMeta = await createGitMeta(resolvedConfig.workspaceDir);
  logger.debug("gitMeta", gitMeta);

  const branch = getBranch({ specified: options.branch, gitMeta });

  if (!branch) {
    throw new Error(
      "Didn't auto-detect branch, so you need to specify a preview branch. Use --branch <branch>."
    );
  }

  const projectClient = await getProjectClient({
    accessToken: authorization.auth.accessToken,
    apiUrl: authorization.auth.apiUrl,
    projectRef: resolvedConfig.project,
    env: "preview",
    branch,
    profile: options.profile,
  });

  if (!projectClient) {
    throw new Error("Failed to get project client");
  }

  const $buildSpinner = spinner();
  $buildSpinner.start(`Archiving "${branch}"`);

  const result = await projectClient.client.archiveBranch(branch);

  $buildSpinner.stop(`Successfully archived ${branch}`);
}
