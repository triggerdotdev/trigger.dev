import { json, type TypedResponse } from "@remix-run/server-runtime";
import { type DevConfigResponseBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    findResource: async () => 1,
    headers: z.object({
      "x-forwarded-for": z.string().optional(),
    }),
  },
  async ({ authentication }): Promise<TypedResponse<DevConfigResponseBody>> => {
    logger.debug("Get dev settings", { environmentId: authentication.environment.id });

    try {
      return json({
        environmentId: authentication.environment.id,
        dequeueIntervalWithRun: env.DEV_DEQUEUE_INTERVAL_WITH_RUN,
        dequeueIntervalWithoutRun: env.DEV_DEQUEUE_INTERVAL_WITHOUT_RUN,
        // Limit max runs to smaller of an optional global limit and the environment limit
        maxConcurrentRuns: Math.min(
          env.DEV_MAX_CONCURRENT_RUNS ?? authentication.environment.maximumConcurrencyLimit,
          authentication.environment.maximumConcurrencyLimit
        ),
        engineUrl: env.DEV_ENGINE_URL,
      });
    } catch (error) {
      logger.error("Failed to get dev settings", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);
