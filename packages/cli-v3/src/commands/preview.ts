import { intro } from "@clack/prompts";
import { getBranch } from "@trigger.dev/core/v3";
import type { Command } from "commander";
import { resolve } from "node:path";
import { z } from "zod";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { loadConfig } from "../config.js";
import { authenticateForDeploy } from "../deploy/auth.js";
import {
  archivePreviewBranch,
  shouldUseGithubOidc,
  trustedDeployApiUrl,
  type PreviewArchiveAuth,
} from "../deploy/trustedDeploy.js";
import { createGitMeta } from "../utilities/gitMeta.js";
import { printStandloneInitialBanner } from "../utilities/initialBanner.js";
import { logger } from "../utilities/logger.js";
import { verifyDirectory } from "./deploy.js";
import { login } from "./login.js";
import { updateTriggerPackages } from "./update.js";

const PreviewCommandOptions = CommonCommandOptions.extend({
  authMethod: z.enum(["auto", "oidc"]).default("auto"),
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
      .option("--auth-method <method>", "Authentication method: auto or oidc", "auto")
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
      await printStandloneInitialBanner(!options.skipUpdateCheck, options.profile);
      await previewArchiveCommand(path, options);
    });
  });
}

async function previewArchiveCommand(dir: string, options: unknown) {
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

  const useOidc = shouldUseGithubOidc(options.authMethod, process.env.TRIGGER_ACCESS_TOKEN);
  let archiveAuth: PreviewArchiveAuth;
  if (useOidc) {
    archiveAuth = { type: "oidc", apiUrl: trustedDeployApiUrl(options) };
  } else {
    const authorization = await authenticateForDeploy({
      accessToken: process.env.TRIGGER_ACCESS_TOKEN,
      apiUrl: process.env.TRIGGER_API_URL ?? options.apiUrl,
      profile: options.profile,
      silent: false,
      login,
    });
    if (!authorization.ok) {
      if (authorization.error === "fetch failed") {
        throw new Error(
          `Failed to connect to ${authorization.auth?.apiUrl}. Are you sure it's the correct URL?`
        );
      }
      throw new Error(
        `You must login first. Use the \`login\` CLI command.\n\n${authorization.error}`
      );
    }
    archiveAuth = { type: "token", ...authorization.auth };
  }
  await archivePreviewBranch(archiveAuth, branch, resolvedConfig.project);
}
