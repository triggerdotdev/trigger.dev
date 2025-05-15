import { recordSpanException } from "@trigger.dev/core/v3/workers";
import { CliApiClient } from "../apiClient.js";
import { readAuthConfigProfile } from "./configFiles.js";
import { getTracer } from "../telemetry/tracing.js";
import { logger } from "./logger.js";

const tracer = getTracer();

export type LoginResultOk = {
  ok: true;
  profile: string;
  userId: string;
  email: string;
  dashboardUrl: string;
  auth: {
    apiUrl: string;
    accessToken: string;
  };
};

export type LoginResult =
  | LoginResultOk
  | {
      ok: false;
      error: string;
      auth?: {
        apiUrl: string;
        accessToken: string;
      };
    };

export async function isLoggedIn(profile: string = "default"): Promise<LoginResult> {
  return await tracer.startActiveSpan("isLoggedIn", async (span) => {
    try {
      const config = readAuthConfigProfile(profile);

      if (!config?.accessToken || !config?.apiUrl) {
        span.recordException(new Error("You must login first"));
        span.end();
        return { ok: false as const, error: "You must login first" };
      }

      const apiClient = new CliApiClient(config.apiUrl, config.accessToken);
      const userData = await apiClient.whoAmI();

      if (!userData.success) {
        recordSpanException(span, userData.error);
        span.end();

        return {
          ok: false as const,
          error: userData.error,
          auth: {
            apiUrl: config.apiUrl,
            accessToken: config.accessToken,
          },
        };
      }

      span.setAttributes({
        "login.userId": userData.data.userId,
        "login.email": userData.data.email,
        "login.dashboardUrl": userData.data.dashboardUrl,
        "login.profile": profile,
      });

      span.end();

      return {
        ok: true as const,
        profile,
        userId: userData.data.userId,
        email: userData.data.email,
        dashboardUrl: userData.data.dashboardUrl,
        auth: {
          apiUrl: config.apiUrl,
          accessToken: config.accessToken,
        },
      };
    } catch (e) {
      recordSpanException(span, e);
      span.end();

      return {
        ok: false as const,
        error: e instanceof Error ? e.message : "Unknown error",
      };
    }
  });
}

export type GetEnvOptions = {
  accessToken: string;
  apiUrl: string;
  projectRef: string;
  env: string;
  branch?: string;
  profile: string;
};

export async function getProjectClient(options: GetEnvOptions) {
  logger.debug(
    `Initializing ${options.env} environment for project ${options.projectRef}`,
    options.apiUrl
  );

  const apiClient = new CliApiClient(options.apiUrl, options.accessToken);

  const projectEnv = await apiClient.getProjectEnv({
    projectRef: options.projectRef,
    env: options.env,
    branch: options.branch,
  });

  if (!projectEnv.success) {
    if (projectEnv.error === "Project not found") {
      logger.error(
        `Project not found: ${options.projectRef}. Ensure you are using the correct project ref and CLI profile (use --profile). Currently using the "${options.profile}" profile, which points to ${options.apiUrl}`
      );
    } else {
      logger.error(
        `Failed to initialize ${options.env} environment: ${projectEnv.error}. Using project ref ${options.projectRef}`
      );
    }

    return;
  }

  const client = new CliApiClient(projectEnv.data.apiUrl, projectEnv.data.apiKey);

  return {
    id: projectEnv.data.projectId,
    name: projectEnv.data.name,
    client,
  };
}
