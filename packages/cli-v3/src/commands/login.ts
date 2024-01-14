import pRetry, { AbortError } from "p-retry";
import open, { openApp, apps } from "open";
import { z } from "zod";
import { logger } from "../utilities/logger";
import { ApiClient } from "../apiClient";
import { spinner, note, log, intro, outro, select } from "@clack/prompts";
import { chalkLink } from "../utilities/colors";
import { readAuthConfigFile, writeAuthConfigFile } from "../utilities/configFiles";

const LoginOptionsSchema = z.object({
  apiUrl: z.string(),
});

export async function loginCommand(options: any) {
  const result = LoginOptionsSchema.safeParse(options);
  if (!result.success) {
    logger.error(result.error.message);
    return;
  }

  return login(result.data.apiUrl);
}

export type LoginResult =
  | {
      success: true;
      accessToken: string;
    }
  | {
      success: false;
      error: string;
    };

export async function login(apiUrl: string): Promise<LoginResult> {
  const apiClient = new ApiClient(apiUrl);

  intro("Logging in to Trigger.dev");

  const existingAccessToken = readAuthConfigFile()?.accessToken;
  if (existingAccessToken) {
    const continueOption = await select({
      message: "You are already logged in.",
      options: [
        {
          value: false,
          label: "Don't login",
        },
        {
          value: true,
          label: "Login with a different token",
        },
      ],
      initialValue: false,
    });

    if (continueOption === false) {
      outro("Already logged in");
      return {
        success: true,
        accessToken: existingAccessToken,
      };
    }
  }

  //generate authorization code
  const createAuthCodeSpinner = spinner();
  createAuthCodeSpinner.start("Creating authorition code");
  const authorizationCodeResult = await apiClient.createAuthorizationCode();
  if (!authorizationCodeResult.success) {
    createAuthCodeSpinner.stop(
      `Failed to create authorization code\n${authorizationCodeResult.error}`
    );
    return {
      success: false,
      error: authorizationCodeResult.error,
    };
  }
  createAuthCodeSpinner.stop("Created authorization code");

  //Link the user to the authorization code
  log.step(
    `Please visit the following URL to login:\n${chalkLink(authorizationCodeResult.data.url)}`
  );
  await open(authorizationCodeResult.data.url);

  //poll for personal access token (we need to poll for it)
  const getPersonalAccessTokenSpinner = spinner();
  getPersonalAccessTokenSpinner.start("Waiting for you to login");
  try {
    const indexResult = await pRetry(
      () => getPersonalAccessToken(apiClient, authorizationCodeResult.data.authorizationCode),
      {
        //this means we're polling, same distance between each attempt
        factor: 1,
        retries: 60,
        minTimeout: 1000,
      }
    );

    getPersonalAccessTokenSpinner.stop(`Logged in with token ${indexResult.obfuscatedToken}`);

    writeAuthConfigFile({ accessToken: indexResult.token });

    outro("Logged in successfully");

    return {
      success: true,
      accessToken: indexResult.token,
    };
  } catch (e) {
    getPersonalAccessTokenSpinner.stop(`Failed to get access token`);
    if (e instanceof AbortError) {
      log.error(e.message);
    }
    return {
      success: false,
      error: e instanceof Error ? e.message : JSON.stringify(e),
    };
  }
}

async function getPersonalAccessToken(apiClient: ApiClient, authorizationCode: string) {
  const token = await apiClient.getPersonalAccessToken(authorizationCode);

  if (!token.success) {
    throw new AbortError(token.error);
  }

  if (!token.data.token) {
    throw new Error("No token found yet");
  }

  return {
    token: token.data.token.token,
    obfuscatedToken: token.data.token.obfuscatedToken,
  };
}
