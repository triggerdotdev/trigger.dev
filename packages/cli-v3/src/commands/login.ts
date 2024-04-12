import { intro, log, outro, select } from "@clack/prompts";
import { recordSpanException } from "@trigger.dev/core/v3";
import { Command } from "commander";
import open from "open";
import pRetry, { AbortError } from "p-retry";
import { z } from "zod";
import { CliApiClient } from "../apiClient.js";
import {
  CommonCommandOptions,
  SkipLoggingError,
  commonOptions,
  handleTelemetry,
  tracer,
  wrapCommandAction,
} from "../cli/common.js";
import { chalkLink } from "../utilities/cliOutput.js";
import { readAuthConfigProfile, writeAuthConfigProfile } from "../utilities/configFiles.js";
import { getVersion } from "../utilities/getVersion.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import { LoginResult } from "../utilities/session.js";
import { whoAmI } from "./whoami.js";
import { logger } from "../utilities/logger.js";
import { spinner } from "../utilities/windows.js";

export const LoginCommandOptions = CommonCommandOptions.extend({
  apiUrl: z.string(),
});

export type LoginCommandOptions = z.infer<typeof LoginCommandOptions>;

export function configureLoginCommand(program: Command) {
  return commonOptions(
    program
      .command("login")
      .description("Login with Trigger.dev so you can perform authenticated actions")
  )
    .version(getVersion(), "-v, --version", "Display the version number")
    .action(async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false);
        await loginCommand(options);
      });
    });
}

export async function loginCommand(options: unknown) {
  return await wrapCommandAction("loginCommand", LoginCommandOptions, options, async (opts) => {
    return await _loginCommand(opts);
  });
}

async function _loginCommand(options: LoginCommandOptions) {
  return login({ defaultApiUrl: options.apiUrl, embedded: false, profile: options.profile });
}

export type LoginOptions = {
  defaultApiUrl?: string;
  embedded?: boolean;
  profile?: string;
};

export async function login(options?: LoginOptions): Promise<LoginResult> {
  return await tracer.startActiveSpan("login", async (span) => {
    try {
      const opts = { defaultApiUrl: "https://api.trigger.dev", embedded: false, ...options };

      span.setAttributes({
        "cli.config.apiUrl": opts.defaultApiUrl,
        "cli.options.profile": opts.profile,
      });

      if (!opts.embedded) {
        intro("Logging in to Trigger.dev");
      }

      const accessTokenFromEnv = process.env.TRIGGER_ACCESS_TOKEN;

      if (accessTokenFromEnv) {
        const auth = {
          accessToken: accessTokenFromEnv,
          apiUrl: process.env.TRIGGER_API_URL ?? "https://api.trigger.dev",
        };
        const apiClient = new CliApiClient(auth.apiUrl, auth.accessToken);
        const userData = await apiClient.whoAmI();

        if (!userData.success) {
          throw new Error(userData.error);
        }

        return {
          ok: true as const,
          profile: options?.profile ?? "default",
          userId: userData.data.userId,
          email: userData.data.email,
          dashboardUrl: userData.data.dashboardUrl,
          auth: {
            accessToken: auth.accessToken,
            apiUrl: auth.apiUrl,
          },
        };
      }

      const authConfig = readAuthConfigProfile(options?.profile);

      if (authConfig && authConfig.accessToken) {
        const whoAmIResult = await whoAmI(
          {
            profile: options?.profile ?? "default",
            skipTelemetry: !span.isRecording(),
            logLevel: logger.loggerLevel,
          },
          opts.embedded
        );

        if (!whoAmIResult.success) {
          throw new Error(whoAmIResult.error);
        } else {
          if (!opts.embedded) {
            const continueOption = await select({
              message: "You are already logged in.",
              options: [
                {
                  value: false,
                  label: "Exit",
                },
                {
                  value: true,
                  label: "Login with a different account",
                },
              ],
              initialValue: false,
            });

            if (continueOption !== true) {
              outro("Already logged in");

              span.setAttributes({
                "cli.userId": whoAmIResult.data.userId,
                "cli.email": whoAmIResult.data.email,
                "cli.config.apiUrl": authConfig.apiUrl ?? opts.defaultApiUrl,
              });

              span.end();

              return {
                ok: true as const,
                profile: options?.profile ?? "default",
                userId: whoAmIResult.data.userId,
                email: whoAmIResult.data.email,
                dashboardUrl: whoAmIResult.data.dashboardUrl,
                auth: {
                  accessToken: authConfig.accessToken,
                  apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
                },
              };
            }
          } else {
            span.setAttributes({
              "cli.userId": whoAmIResult.data.userId,
              "cli.email": whoAmIResult.data.email,
              "cli.config.apiUrl": authConfig.apiUrl ?? opts.defaultApiUrl,
            });

            span.end();

            return {
              ok: true as const,
              profile: options?.profile ?? "default",
              userId: whoAmIResult.data.userId,
              email: whoAmIResult.data.email,
              dashboardUrl: whoAmIResult.data.dashboardUrl,
              auth: {
                accessToken: authConfig.accessToken,
                apiUrl: authConfig.apiUrl ?? opts.defaultApiUrl,
              },
            };
          }
        }
      }

      if (opts.embedded) {
        log.step("You must login to continue.");
      }

      const apiClient = new CliApiClient(authConfig?.apiUrl ?? opts.defaultApiUrl);

      //generate authorization code
      const authorizationCodeResult = await createAuthorizationCode(apiClient);

      //Link the user to the authorization code
      log.step(
        `Please visit the following URL to login:\n${chalkLink(authorizationCodeResult.url)}`
      );

      await open(authorizationCodeResult.url);

      //poll for personal access token (we need to poll for it)
      const getPersonalAccessTokenSpinner = spinner();
      getPersonalAccessTokenSpinner.start("Waiting for you to login");
      try {
        const indexResult = await pRetry(
          () => getPersonalAccessToken(apiClient, authorizationCodeResult.authorizationCode),
          {
            //this means we're polling, same distance between each attempt
            factor: 1,
            retries: 60,
            minTimeout: 1000,
          }
        );

        getPersonalAccessTokenSpinner.stop(`Logged in with token ${indexResult.obfuscatedToken}`);

        writeAuthConfigProfile(
          { accessToken: indexResult.token, apiUrl: opts.defaultApiUrl },
          options?.profile
        );

        const whoAmIResult = await whoAmI(
          {
            profile: options?.profile ?? "default",
            skipTelemetry: !span.isRecording(),
            logLevel: logger.loggerLevel,
          },
          opts.embedded
        );

        if (!whoAmIResult.success) {
          throw new Error(whoAmIResult.error);
        }

        if (opts.embedded) {
          log.step("Logged in successfully");
        } else {
          outro("Logged in successfully");
        }

        span.end();

        return {
          ok: true as const,
          profile: options?.profile ?? "default",
          userId: whoAmIResult.data.userId,
          email: whoAmIResult.data.email,
          dashboardUrl: whoAmIResult.data.dashboardUrl,
          auth: {
            accessToken: indexResult.token,
            apiUrl: authConfig?.apiUrl ?? opts.defaultApiUrl,
          },
        };
      } catch (e) {
        getPersonalAccessTokenSpinner.stop(`Failed to get access token`);

        if (e instanceof AbortError) {
          log.error(e.message);
        }

        recordSpanException(span, e);
        span.end();

        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }
    } catch (e) {
      recordSpanException(span, e);
      span.end();

      if (options?.embedded) {
        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      throw e;
    }
  });
}

async function getPersonalAccessToken(apiClient: CliApiClient, authorizationCode: string) {
  return await tracer.startActiveSpan("getPersonalAccessToken", async (span) => {
    try {
      const token = await apiClient.getPersonalAccessToken(authorizationCode);

      if (!token.success) {
        throw new AbortError(token.error);
      }

      if (!token.data.token) {
        throw new Error("No token found yet");
      }

      span.end();

      return {
        token: token.data.token.token,
        obfuscatedToken: token.data.token.obfuscatedToken,
      };
    } catch (e) {
      if (e instanceof AbortError) {
        recordSpanException(span, e);
      }

      span.end();

      throw e;
    }
  });
}

async function createAuthorizationCode(apiClient: CliApiClient) {
  return await tracer.startActiveSpan("createAuthorizationCode", async (span) => {
    try {
      //generate authorization code
      const createAuthCodeSpinner = spinner();
      createAuthCodeSpinner.start("Creating authorition code");
      const authorizationCodeResult = await apiClient.createAuthorizationCode();

      if (!authorizationCodeResult.success) {
        createAuthCodeSpinner.stop(
          `Failed to create authorization code\n${authorizationCodeResult.error}`
        );

        throw new SkipLoggingError(
          `Failed to create authorization code\n${authorizationCodeResult.error}`
        );
      }

      createAuthCodeSpinner.stop("Created authorization code");

      span.end();

      return authorizationCodeResult.data;
    } catch (e) {
      recordSpanException(span, e);

      span.end();

      throw e;
    }
  });
}
