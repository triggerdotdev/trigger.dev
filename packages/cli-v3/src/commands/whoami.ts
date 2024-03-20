import { intro, note, spinner } from "@clack/prompts";
import { chalkLink } from "../utilities/colors.js";
import { logger } from "../utilities/logger.js";
import { isLoggedIn } from "../utilities/session.js";
import { Command } from "commander";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { CommonCommandOptions, commonOptions, handleTelemetry, wrapCommandAction } from "../cli/common.js";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";

type WhoAmIResult =
  | {
    success: true;
    data: {
      userId: string;
      email: string;
      dashboardUrl: string;
    };
  }
  | {
    success: false;
    error: string;
  };

const WhoamiCommandOptions = CommonCommandOptions;

type WhoamiCommandOptions = z.infer<typeof WhoamiCommandOptions>;

export function configureWhoamiCommand(program: Command) {
  return commonOptions(program
    .command("whoami")
    .description("display the current logged in user and project details"))
    .action(async (options) => {
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
  embedded: boolean = false
): Promise<WhoAmIResult> {
  if (!embedded) {
    intro(`Displaying your account details [${options?.profile ?? "default"}]`);
  }

  const loadingSpinner = spinner();
  loadingSpinner.start("Checking your account details");

  const authentication = await isLoggedIn(options?.profile);

  if (!authentication.ok) {
    if (authentication.error === "fetch failed") {
      loadingSpinner.stop("Fetch failed. Platform down?");
    } else {
      loadingSpinner.stop(`You must login first. Use \`trigger.dev login --profile ${options?.profile ?? "default"}\` to login.`);
    }

    return {
      success: false,
      error: authentication.error,
    };
  }

  const apiClient = new CliApiClient(authentication.auth.apiUrl, authentication.auth.accessToken);
  const userData = await apiClient.whoAmI();

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
Email: ${userData.data.email}
URL: ${chalkLink(authentication.auth.apiUrl)}
`,
      `Account details [${authentication.profile}]`
    );
  } else {
    loadingSpinner.stop(`Retrieved your account details for ${userData.data.email}`);
  }

  return userData;
}
