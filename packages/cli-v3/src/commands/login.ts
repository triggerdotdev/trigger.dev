import { intro, log, outro, select } from "@clack/prompts";
import { recordSpanException } from "@trigger.dev/core/v3/workers";
import type { Command } from "commander";
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
import { chalkLink, prettyError } from "../utilities/cliOutput.js";
import {
  deletePendingAuthorization,
  deletePendingProfileName,
  type PendingAuthorization,
  readAuthConfigProfile,
  writeAuthConfigProfile,
  writeAuthConfigCurrentProfileName,
  writePendingAuthorization,
  writePendingProfileName,
} from "../utilities/configFiles.js";
import { printInitialBanner } from "../utilities/initialBanner.js";
import {
  awaitAndDisplayPlatformNotification,
  fetchPlatformNotification,
} from "../utilities/platformNotifications.js";
import type { LoginResult } from "../utilities/session.js";
import { whoAmI } from "./whoami.js";
import { logger } from "../utilities/logger.js";
import { spinner } from "../utilities/windows.js";
import { isLinuxServer } from "../utilities/linux.js";
import { VERSION } from "../version.js";
import { env, isCI } from "std-env";
import { CLOUD_API_URL } from "../consts.js";
import {
  validateAccessToken,
  NotPersonalAccessTokenError,
  NotAccessTokenError,
} from "../utilities/accessTokens.js";
import { links } from "@trigger.dev/core/v3";

const LoginCommandOptions = CommonCommandOptions.extend({
  browser: z.boolean().default(true),
  email: z.string().email().optional(),
  name: z.string().trim().min(3).max(50).optional(),
  cancelPending: z.boolean().default(false),
  wait: z.boolean().default(true),
});

type LoginCommandOptions = z.infer<typeof LoginCommandOptions>;

export function configureLoginCommand(program: Command) {
  return commonOptions(
    program
      .command("login")
      .summary("Login with Trigger.dev so you can perform authenticated actions")
      .description(
        `Login with Trigger.dev so you can perform authenticated actions.

Examples:
  # Interactive login (opens browser)
  $ trigger.dev login

  # Headless / agent (print URL and resume later)
  $ trigger.dev login --email you@example.com --name "Alex Smith" --no-browser --no-wait
  $ trigger.dev login --no-browser

  # Login to a named profile
  $ trigger.dev login --profile staging`
      )
      .option("--no-browser", "Don't automatically open the browser; print the URL only")
      .option("--email <email>", "Prefill the email address on the login page")
      .option("--name <name>", "Set your full name after authorization")
      .option("--cancel-pending", "Cancel a pending login and keep the current account")
      .option("--no-wait", "Save the authorization and exit so login can be resumed later")
  )
    .version(VERSION, "-v, --version", "Display the version number")
    .action(async (options) => {
      await handleTelemetry(async () => {
        await printInitialBanner(false, options.profile);
        await loginCommand(options);
      });
    });
}

async function loginCommand(options: unknown) {
  return await wrapCommandAction("loginCommand", LoginCommandOptions, options, async (opts) => {
    return await _loginCommand(opts);
  });
}

async function _loginCommand(options: LoginCommandOptions) {
  return login({
    defaultApiUrl: options.apiUrl,
    embedded: false,
    profile: options.profile,
    browser: options.browser,
    email: options.email,
    name: options.name,
    cancelPending: options.cancelPending,
    wait: options.wait,
  });
}

export type LoginOptions = {
  defaultApiUrl?: string;
  embedded?: boolean;
  profile?: string;
  silent?: boolean;
  browser?: boolean;
  email?: string;
  name?: string;
  cancelPending?: boolean;
  wait?: boolean;
};

export const PENDING_AUTHORIZATION_ERROR =
  "A login is pending. Run `trigger.dev login` to complete it, or `trigger.dev login --cancel-pending` to keep using the current account.";

export function resolveLoginOptions(options?: LoginOptions) {
  return {
    embedded: false,
    silent: false,
    wait: true,
    ...options,
    defaultApiUrl: options?.defaultApiUrl ?? CLOUD_API_URL,
  };
}

export async function login(options?: LoginOptions): Promise<LoginResult> {
  return await tracer.startActiveSpan("login", async (span) => {
    try {
      const opts = resolveLoginOptions(options);

      span.setAttributes({
        "cli.config.apiUrl": opts.defaultApiUrl,
        "cli.options.profile": opts.profile,
      });

      if (!opts.embedded) {
        intro("Logging in to Trigger.dev");
      }

      const authConfig = readAuthConfigProfile(options?.profile);

      if (opts.cancelPending) {
        if (authConfig?.pendingAuthorization) {
          deletePendingAuthorization(options?.profile);
          if (!opts.embedded) {
            outro("Pending login cancelled. Your current account is unchanged.");
          }
        } else if (!opts.embedded) {
          outro("There is no pending login to cancel.");
        }

        span.end();
        return { ok: false as const, error: "Pending login cancelled" };
      }

      const accessTokenFromEnv = env.TRIGGER_ACCESS_TOKEN;

      if (accessTokenFromEnv) {
        const validationResult = validateAccessToken(accessTokenFromEnv);

        if (!validationResult.success) {
          // We deliberately don't surface the existence of organization access tokens to the user for now, as they're only used internally.
          // Once we expose them in the application, we should also communicate that option here.
          throw new NotAccessTokenError(
            "Your TRIGGER_ACCESS_TOKEN is not a Personal Access Token, they start with 'tr_pat_'. You can generate one here: https://cloud.trigger.dev/account/tokens"
          );
        }

        const auth = {
          accessToken: accessTokenFromEnv,
          apiUrl: env.TRIGGER_API_URL ?? opts.defaultApiUrl ?? CLOUD_API_URL,
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
            tokenType: validationResult.type,
            apiUrl: auth.apiUrl,
          },
        };
      }

      const configuredApiUrl =
        options?.defaultApiUrl ??
        authConfig?.pendingAuthorization?.apiUrl ??
        authConfig?.apiUrl ??
        CLOUD_API_URL;
      const apiUrlChanged =
        options?.defaultApiUrl !== undefined && options.defaultApiUrl !== authConfig?.apiUrl;
      const resumableAuthorization = isPendingAuthorizationValid(
        authConfig?.pendingAuthorization,
        configuredApiUrl
      )
        ? authConfig.pendingAuthorization
        : undefined;

      if (authConfig?.pendingAuthorization && !resumableAuthorization) {
        deletePendingAuthorization(options?.profile);
      }

      if (opts.embedded && resumableAuthorization) {
        span.end();
        return { ok: false as const, error: PENDING_AUTHORIZATION_ERROR };
      }

      if (
        resumableAuthorization &&
        authConfig?.accessToken &&
        !opts.embedded &&
        opts.browser !== false &&
        process.stdin.isTTY
      ) {
        const pendingChoice = await select({
          message: "Another login is awaiting approval.",
          options: [
            { value: "resume", label: "Complete account switch" },
            { value: "cancel", label: "Cancel switch and keep current account" },
            { value: "exit", label: "Exit" },
          ],
          initialValue: "resume",
        });

        if (pendingChoice === "cancel") {
          deletePendingAuthorization(options?.profile);
          outro("Pending login cancelled. Your current account is unchanged.");
          span.end();
          return { ok: false as const, error: "Pending login cancelled" };
        }

        if (pendingChoice !== "resume") {
          outro("Pending login left unchanged.");
          span.end();
          return { ok: false as const, error: "Authorization pending" };
        }
      }

      if (authConfig?.accessToken && !resumableAuthorization && !apiUrlChanged) {
        await completeProfileIfNeeded({
          apiClient: new CliApiClient(configuredApiUrl, authConfig.accessToken),
          name: authConfig.pendingProfileName,
          profile: options?.profile,
        });
        const whoAmIResult = await whoAmI(
          {
            profile: options?.profile ?? "default",
            skipTelemetry: !span.isRecording(),
            logLevel: logger.loggerLevel,
          },
          true,
          opts.silent
        );

        if (!whoAmIResult.success) {
          prettyError("Unable to validate existing personal access token", whoAmIResult.error);

          if (!opts.embedded) {
            outro(
              `Login failed using stored token. To fix, first logout using \`trigger.dev logout${
                options?.profile ? ` --profile ${options.profile}` : ""
              }\` and then try again.`
            );

            throw new SkipLoggingError(whoAmIResult.error);
          } else {
            throw new Error(whoAmIResult.error);
          }
        } else {
          if (opts.embedded) {
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
                tokenType: "personal" as const,
              },
            };
          }

          if (opts.wait) {
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
                  tokenType: "personal" as const,
                },
              };
            }
          }
        }
      }

      if (isCI && !resumableAuthorization) {
        const apiUrl =
          env.TRIGGER_API_URL ?? authConfig?.apiUrl ?? opts.defaultApiUrl ?? CLOUD_API_URL;

        const isSelfHosted = apiUrl !== CLOUD_API_URL;

        // This is fine, as the api URL will generally be the same as the dashboard URL for self-hosted instances
        const dashboardUrl = isSelfHosted ? apiUrl : "https://cloud.trigger.dev";

        throw new Error(
          `Authentication required in CI environment. Please set the TRIGGER_ACCESS_TOKEN environment variable with a Personal Access Token.

- You can generate one here: ${dashboardUrl}/account/tokens

- For more information, see: ${links.docs.gitHubActions.personalAccessToken}`
        );
      }

      if (opts.embedded) {
        log.step("You must login to continue.");
      }

      const apiUrl = configuredApiUrl;
      const apiClient = new CliApiClient(apiUrl);
      const { pendingAuthorization, resumed } = await getOrCreatePendingAuthorization({
        apiClient,
        apiUrl,
        email: opts.email,
        name: opts.name,
        profile: options?.profile,
        existing: resumableAuthorization,
      });
      const resumedToken = resumed
        ? await getPersonalAccessTokenIfReady(
            apiClient,
            pendingAuthorization.authorizationCode,
            options?.profile
          )
        : undefined;

      if (!resumedToken) {
        log.step(
          `Please visit the following URL to login:\n${chalkLink(pendingAuthorization.url)}`
        );

        if (opts.browser === false) {
          log.message("Browser auto-open disabled. Visit the URL above to login.");
        } else if (await isLinuxServer()) {
          log.message("Please install `xdg-utils` to automatically open the login URL.");
        } else {
          await open(pendingAuthorization.url);
        }

        if (!opts.wait) {
          if (!opts.embedded) {
            outro(
              `Authorization saved. Run \`trigger.dev login${
                options?.profile ? ` --profile ${options.profile}` : ""
              }\` again after approving access.`
            );
          }

          span.end();
          return {
            ok: false as const,
            error: "Authorization pending",
          };
        }
      }

      const getPersonalAccessTokenSpinner = spinner();
      if (!resumedToken) {
        getPersonalAccessTokenSpinner.start("Waiting for you to login");
      }
      try {
        const indexResult =
          resumedToken ??
          (await pRetry(
            () => getPersonalAccessToken(apiClient, pendingAuthorization.authorizationCode),
            {
              //poll at a fixed 1s interval. ~5 min window so the user has time to
              //approve the consent screen; stays within the code's 10-min validity.
              factor: 1,
              retries: 300,
              minTimeout: 1000,
            }
          ));

        if (resumedToken) {
          log.success(`Logged in with token ${indexResult.obfuscatedToken}`);
        } else {
          getPersonalAccessTokenSpinner.stop(`Logged in with token ${indexResult.obfuscatedToken}`);
        }

        writeAuthConfigProfile(
          {
            accessToken: indexResult.token,
            apiUrl,
            pendingProfileName: pendingAuthorization.name,
          },
          options?.profile
        );

        await completeProfileIfNeeded({
          apiClient: new CliApiClient(apiUrl, indexResult.token),
          name: pendingAuthorization.name,
          profile: options?.profile,
        });

        // Only fetch notifications for standalone login, not when embedded in dev
        // (dev.ts handles its own notification fetch to avoid double counting)
        const notificationPromise = opts.embedded
          ? undefined
          : fetchPlatformNotification({
              apiClient: new CliApiClient(apiUrl, indexResult.token),
            });

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

        const profileName = options?.profile ?? "default";

        // Set this profile as the current default
        writeAuthConfigCurrentProfileName(profileName);

        if (opts.embedded) {
          log.step("Logged in successfully");
        } else {
          outro("Logged in successfully");
        }

        await awaitAndDisplayPlatformNotification(notificationPromise);

        span.end();

        return {
          ok: true as const,
          profile: profileName,
          userId: whoAmIResult.data.userId,
          email: whoAmIResult.data.email,
          dashboardUrl: whoAmIResult.data.dashboardUrl,
          auth: {
            accessToken: indexResult.token,
            apiUrl,
            tokenType: "personal" as const,
          },
        };
      } catch (e) {
        if (!resumedToken) {
          getPersonalAccessTokenSpinner.stop(`Failed to get access token`);
        }

        if (e instanceof AbortError) {
          deletePendingAuthorization(options?.profile);
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
        if (e instanceof NotPersonalAccessTokenError) {
          throw e;
        }

        return {
          ok: false as const,
          error: e instanceof Error ? e.message : String(e),
        };
      }

      throw e;
    }
  });
}

const AUTHORIZATION_CODE_TTL_MS = 10 * 60 * 1000;

export function addEmailToAuthorizationUrl(url: string, email?: string) {
  if (!email) return url;

  const authorizationUrl = new URL(url);
  authorizationUrl.searchParams.set("email", email);
  return authorizationUrl.href;
}

export function isPendingAuthorizationValid(
  pendingAuthorization: PendingAuthorization | undefined,
  apiUrl: string,
  now = Date.now()
): pendingAuthorization is PendingAuthorization {
  if (!pendingAuthorization || pendingAuthorization.apiUrl !== apiUrl) {
    return false;
  }

  const createdAt = Date.parse(pendingAuthorization.createdAt);
  return Number.isFinite(createdAt) && now - createdAt < AUTHORIZATION_CODE_TTL_MS;
}

async function getOrCreatePendingAuthorization({
  apiClient,
  apiUrl,
  email,
  name,
  profile,
  existing,
}: {
  apiClient: CliApiClient;
  apiUrl: string;
  email?: string;
  name?: string;
  profile?: string;
  existing?: PendingAuthorization;
}) {
  if (isPendingAuthorizationValid(existing, apiUrl)) {
    const pendingAuthorization = {
      ...existing,
      url: addEmailToAuthorizationUrl(existing.url, email),
      name: name ?? existing.name,
    };
    writePendingAuthorization(pendingAuthorization, profile);
    return { pendingAuthorization, resumed: true };
  }

  if (existing) {
    deletePendingAuthorization(profile);
  }

  const authorizationCodeResult = await createAuthorizationCode(apiClient);
  const pendingAuthorization = {
    authorizationCode: authorizationCodeResult.authorizationCode,
    url: addEmailToAuthorizationUrl(authorizationCodeResult.url, email),
    apiUrl,
    createdAt: new Date().toISOString(),
    name,
  } satisfies PendingAuthorization;

  writePendingAuthorization(pendingAuthorization, profile);
  return { pendingAuthorization, resumed: false };
}

async function completeProfileIfNeeded({
  apiClient,
  name,
  profile,
}: {
  apiClient: CliApiClient;
  name?: string;
  profile?: string;
}) {
  if (!name) {
    return;
  }

  try {
    const result = await apiClient.completeProfile({ name });

    if (!result.success) {
      writePendingProfileName(name, profile);
      log.warn(`Logged in, but failed to save your name: ${result.error}`);
      return;
    }

    deletePendingProfileName(profile);
    if (result.data.updated) {
      log.success("Saved your account details");
    }
  } catch (error) {
    writePendingProfileName(name, profile);
    log.warn(
      `Logged in, but failed to save your name: ${error instanceof Error ? error.message : String(error)}`
    );
  }
}

class AuthorizationPendingError extends Error {}

async function getPersonalAccessTokenIfReady(
  apiClient: CliApiClient,
  authorizationCode: string,
  profile?: string
) {
  try {
    return await getPersonalAccessToken(apiClient, authorizationCode);
  } catch (error) {
    if (error instanceof AbortError) {
      deletePendingAuthorization(profile);
      throw error;
    }

    if (error instanceof AuthorizationPendingError) {
      return undefined;
    }

    throw error;
  }
}

export async function getPersonalAccessToken(apiClient: CliApiClient, authorizationCode: string) {
  return await tracer.startActiveSpan("getPersonalAccessToken", async (span) => {
    try {
      const token = await apiClient.getPersonalAccessToken(authorizationCode);

      if (!token.success) {
        // A 429 from the per-code poll rate limiter is transient. Keep polling
        // rather than abandoning the login.
        if (token.statusCode === 429) {
          throw new AuthorizationPendingError(token.error);
        }

        throw new AbortError(token.error);
      }

      if (!token.data.token) {
        throw new AuthorizationPendingError("No token found yet");
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
      createAuthCodeSpinner.start("Creating authorization code");
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
