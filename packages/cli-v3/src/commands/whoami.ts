import { note, spinner } from "@clack/prompts";
import { ApiClient } from "../apiClient";
import { ApiUrlOptionsSchema } from "../cli";
import { readAuthConfigFile } from "../utilities/configFiles";
import { logger } from "../utilities/logger";
import { login } from "./login";
import { isLoggedIn } from "../utilities/session";
import { chalkLink } from "../utilities/colors";

type WhoAmIResult =
  | {
      success: true;
      data: {
        userId: string;
        email: string;
      };
    }
  | {
      success: false;
      error: string;
    };

export async function whoamiCommand(): Promise<WhoAmIResult> {
  return whoAmI();
}

export async function whoAmI(): Promise<WhoAmIResult> {
  const loadingSpinner = spinner();
  loadingSpinner.start("Checking your account details");

  const authentication = await isLoggedIn();

  if (!authentication.ok) {
    loadingSpinner.stop("You must login first. Use `trigger.dev login` to login.");

    return {
      success: false,
      error: authentication.error,
    };
  }

  const apiClient = new ApiClient(authentication.config.apiUrl, authentication.config.accessToken);
  const userData = await apiClient.whoAmI();

  if (!userData.success) {
    loadingSpinner.stop("Error getting your account details");
    logger.error(userData.error);
    return {
      success: false,
      error: userData.error,
    };
  }

  loadingSpinner.stop("Retrieved your account details");

  note(
    `User ID: ${userData.data.userId}
Email: ${userData.data.email}
URL: ${chalkLink(authentication.config.apiUrl)}
`,
    "Account details"
  );

  return userData;
}
