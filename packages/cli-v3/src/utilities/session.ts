import { recordSpanException } from "@trigger.dev/core/v3";
import { CliApiClient } from "../apiClient.js";
import { readAuthConfigFile } from "./configFiles.js";
import { getTracer } from "../telemetry/tracing.js";

const tracer = getTracer();

export async function isLoggedIn() {
  return await tracer.startActiveSpan("isLoggedIn", async (span) => {
    try {
      const config = readAuthConfigFile();

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
          config: {
            apiUrl: config.apiUrl,
            accessToken: config.accessToken,
          },
        };
      }

      span.setAttributes({
        userId: userData.data.userId,
        email: userData.data.email,
      });

      span.end();

      return {
        ok: true as const,
        userId: userData.data.userId,
        email: userData.data.email,
        config: {
          apiUrl: config.apiUrl,
          accessToken: config.accessToken,
        },
      };
    } catch (e) {
      recordSpanException(span, e);
      span.end();

      throw e;
    }
  });
}
