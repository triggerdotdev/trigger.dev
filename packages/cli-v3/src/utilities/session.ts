import { recordSpanException } from "@trigger.dev/core/v3/workers";
import { CliApiClient } from "../apiClient.js";
import { readAuthConfigProfile } from "./configFiles.js";
import { getTracer } from "../telemetry/tracing.js";

const tracer = getTracer();

export type LoginResult =
  | {
      ok: true;
      profile: string;
      userId: string;
      email: string;
      dashboardUrl: string;
      auth: {
        apiUrl: string;
        accessToken: string;
      };
    }
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
