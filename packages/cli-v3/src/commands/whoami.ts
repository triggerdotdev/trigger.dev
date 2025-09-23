import { intro, note, outro } from "@clack/prompts";
import { chalkLink } from "../utilities/cliOutput.js";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { Command } from "commander";
import { printInitialBanner } from "../utilities/initialBanner.js";
import {
  CommonCommandOptions,
  commonOptions,
  handleTelemetry,
  wrapCommandAction,
} from "../cli/common.js";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import { spinner } from "../utilities/windows.js";
import { loadConfig } from "../config.js";
import { resolveLocalEnvVars } from "../utilities/localEnvVars.js";
import { tryCatch } from "@trigger.dev/core";
import { readAuthConfigCurrentProfileName } from "../utilities/configFiles.js";

type WhoAmIResult =
  | {
      success: true;
      data: {
        userId: string;
        email: string;
        dashboardUrl: string;
        projectUrl?: string;
      };
    }
  | {
      success: false;
      error: string;
    };

const WhoamiCommandOptions = CommonCommandOptions.extend({
  config: z.string().optional(),
  projectRef: z.string().optional(),
  envFile: z.string().optional(),
});

type WhoamiCommandOptions = z.infer<typeof WhoamiCommandOptions>;

export function configureWhoamiCommand(program: Command) {
  return commonOptions(
    program
      .command("whoami")
      .description("display the current logged in user and project details")
      .option("-c, --config <config file>", "The name of the config file")
      .option(
        "-p, --project-ref <project ref>",
        "The project ref. This will override the project specified in the config file."
      )
      .option(
        "--env-file <env file>",
        "Path to the .env file to load into the CLI process. Defaults to .env in the project directory."
      )
  ).action(async (options) => {
    await handleTelemetry(async () => {
      await printInitialBanner(false);
      await whoAmICommand(options);
    });
  });
}

export async function whoAmICommand(options: unknown) {
  return await wrapCommandAction("whoamiCommand", WhoamiCommandOptions, options, async (opts) => {
    return await whoAmI(opts);
  });
}

export async function whoAmI(
  options?: WhoamiCommandOptions,
  embedded: boolean = false,
  silent: boolean = false
): Promise<WhoAmIResult> {
  const profileToUse = options?.profile?.trim() || readAuthConfigCurrentProfileName();

  if (!embedded) {
    intro(`Displaying your account details [${profileToUse}]`);
  }

  const envVars = resolveLocalEnvVars(options?.envFile);

  if (envVars.TRIGGER_PROJECT_REF) {
    logger.debug("Using project ref from env", { ref: envVars.TRIGGER_PROJECT_REF });
  }

  const [configError, resolvedConfig] = await tryCatch(
    loadConfig({
      overrides: { project: options?.projectRef ?? envVars.TRIGGER_PROJECT_REF },
      configFile: options?.config,
      warn: false,
    })
  );

  if (configError) {
    logger.debug("Error loading config", { error: configError });
  }

  const loadingSpinner = spinner();

  if (!silent) {
    loadingSpinner.start("Checking your account details");
  }

  const authentication = await isLoggedIn(profileToUse);

  if (!authentication.ok) {
    if (authentication.error === "fetch failed") {
      !silent && loadingSpinner.stop("Fetch failed. Platform down?");
    } else {
      if (embedded) {
        !silent &&
          loadingSpinner.stop(
            `Failed to check account details. You may want to run \`trigger.dev logout --profile ${profileToUse}\` and try again.`
          );
      } else {
        loadingSpinner.stop(
          `You must login first. Use \`trigger.dev login --profile ${profileToUse}\` to login.`
        );
        outro(`Whoami failed: ${authentication.error}`);
      }
    }

    return {
      success: false,
      error: authentication.error,
    };
  }

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const userData = await apiClient.whoAmI(resolvedConfig?.project);

  if (!userData.success) {
    loadingSpinner.stop("Error getting your account details");
    logger.error(userData.error);
    return {
      success: false,
      error: userData.error,
    };
  }

  if (!embedded) {
    loadingSpinner.stop("Retrieved your account details");
    note(
      `User ID: ${userData.data.userId}
Email:   ${userData.data.email}
URL:     ${chalkLink(authentication.auth.apiUrl)}`,
      `Account details [${profileToUse}]`
    );

    const { project } = userData.data;

    if (project) {
      note(
        `Name: ${project.name}
Org:  ${project.orgTitle}
URL:  ${chalkLink(project.url)}`,
        `Project details [${resolvedConfig?.project}]`
      );
    }
  } else {
    !silent && loadingSpinner.stop(`Retrieved your account details for ${userData.data.email}`);
  }

  return userData;
}
