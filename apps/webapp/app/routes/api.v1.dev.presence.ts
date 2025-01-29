import { json, TypedResponse } from "@remix-run/server-runtime";
import { DevConfigResponseBody } from "@trigger.dev/core/v3/schemas";
import { Redis } from "ioredis";
import { z } from "zod";
import { env } from "~/env.server";
import { DevPresenceStream } from "~/presenters/v3/DevPresenceStream.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderApiRoute(
  {
    findResource: async () => 1,
    headers: z.object({
      "x-forwarded-for": z.string().optional(),
    }),
  },
  async ({ request, authentication }): Promise<Response> => {
    logger.debug("Start dev presence SSE session", {
      environmentId: authentication.environment.id,
    });

    const redis = new Redis({
      port: env.VALKEY_PORT ?? undefined,
      host: env.VALKEY_HOST ?? undefined,
      username: env.VALKEY_USERNAME ?? undefined,
      password: env.VALKEY_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.VALKEY_TLS_DISABLED === "true" ? {} : { tls: {} }),
    });
    const presence = new DevPresenceStream(redis);

    try {
      return presence.handleCliConnection({ request, environment: authentication.environment });
    } catch (error) {
      logger.error("Failed to connect to CLI", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);
