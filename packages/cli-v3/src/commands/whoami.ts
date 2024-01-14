import { note, spinner } from "@clack/prompts";
import { ApiUrlOptionsSchema } from "../cli";
import { logger } from "../utilities/logger";
import { resolvePath } from "../utilities/parseNameAndPath";
import { readAuthConfigFile } from "../utilities/configFiles";
import { login } from "./login";
import { ApiClient } from "../apiClient";

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

export async function whoamiCommand(options: any): Promise<WhoAmIResult> {
  const result = ApiUrlOptionsSchema.safeParse(options);
  if (!result.success) {
    logger.error(result.error.message);
    return {
      success: false,
      error: result.error.message,
    };
  }

  return whoAmI(result.data.apiUrl);
}

export async function whoAmI(apiUrl: string): Promise<WhoAmIResult> {
  const loadingSpinner = spinner();
  loadingSpinner.start("Checking your account details");

  if (!readAuthConfigFile()?.accessToken) {
    loadingSpinner.stop("You must login.");
    const loginResult = await login(apiUrl);
    if (!loginResult.success) {
      logger.error(loginResult.error);
      return {
        success: false,
        error: loginResult.error,
      };
    }
  }

  const accessToken = readAuthConfigFile()?.accessToken;
  if (!accessToken) {
    logger.error("No access token after login… this should never happen");
    return {
      success: false,
      error: "No access token after login… this should never happen",
    };
  }

  const apiClient = new ApiClient(apiUrl);
  const userData = await apiClient.whoAmI({ accessToken });

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
Email: ${userData.data.email}`,
    "Account details"
  );

  return userData;
}
