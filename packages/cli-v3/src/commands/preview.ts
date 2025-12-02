import { intro } from "@clack/prompts";
import { getBranch } from "@trigger.dev/core/v3";
import { Command } from "commander";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { getProjectClient, LoginResultOk } from "../utilities/session.js";
import { spinner } from "../utilities/windows.js";
import { verifyDirectory } from "./deploy.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";
import { CliApiClient } from "../apiClient.js";

const PreviewCommandOptions = CommonCommandOptions.extend({
  branch: z.string().optional(),
  config: z.string().optional(),
  projectRef: z.string().optional(),
  skipUpdateCheck: z.boolean().default(false),
});

type PreviewCommandOptions = z.infer<typeof PreviewCommandOptions>;

export function configurePreviewCommand(program: Command) {
  const preview = program.command("preview").description("Modify preview branches");

  commonOptions(
    preview
      .command("archive")
      .description("Archive a preview branch")
      .argument("[path]", "The path to the project", ".")
      .option(
        "-b, --branch <branch>",
        "The preview branch to archive. If not provided, we'll detect your local git branch."
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
      await printStandloneInitialBanner(true, options.profile);
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

  const $buildSpinner = spinner();
  $buildSpinner.start(`Archiving "${branch}"`);
  const result = await archivePreviewBranch(authorization, branch, resolvedConfig.project);
  $buildSpinner.stop(
    result ? `Successfully archived "${branch}"` : `Failed to archive "${branch}".`
  );
  return result;
}

export async function archivePreviewBranch(
  authorization: LoginResultOk,
  branch: string,
  project: string
) {
  const apiClient = new CliApiClient(authorization.auth.apiUrl, authorization.auth.accessToken);

  const result = await apiClient.archiveBranch(project, branch);

  if (result.success) {
    return true;
  } else {
    logger.error(result.error);
    return false;
  }
}
