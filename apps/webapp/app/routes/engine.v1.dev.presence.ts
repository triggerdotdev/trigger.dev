import { json } from "@remix-run/server-runtime";
import { Redis } from "ioredis";
import { env } from "~/env.server";
import { DevPresenceStream } from "~/presenters/v3/DevPresenceStream.server";
import { authenticateApiRequestWithFailure } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createSSELoader } from "~/utils/sse";

const redis = new Redis({
  port: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PORT ?? undefined,
  host: env.RUN_ENGINE_DEV_PRESENCE_REDIS_HOST ?? undefined,
  username: env.RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME ?? undefined,
  password: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD ?? undefined,
  enableAutoPipelining: true,
  ...(env.RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
});

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_TTL_MS,
  interval: env.DEV_PRESENCE_POLL_INTERVAL_MS,
  debug: true,
  handler: async ({ id, controller, debug, request }) => {
    const authentication = await authenticateApiRequestWithFailure(request);

    if (!authentication.ok) {
      throw json({ error: "Invalid or Missing API key" }, { status: 401 });
    }

    const environmentId = authentication.environment.id;

    const presenceKey = DevPresenceStream.getPresenceKey(environmentId);
    const presenceChannel = DevPresenceStream.getPresenceChannel(environmentId);

    return {
      beforeStream: async () => {
        logger.debug("Start dev presence SSE session", {
          environmentId,
          presenceKey,
          presenceChannel,
        });
      },
      initStream: async ({ send }) => {
        // Set initial presence with more context
        await redis.setex(presenceKey, env.DEV_PRESENCE_TTL_MS / 1000, new Date().toISOString());

        // Publish presence update
        await redis.publish(
          presenceChannel,
          JSON.stringify({
            type: "connected",
            environmentId,
            timestamp: Date.now(),
          })
        );

        send({ event: "start", data: `Started ${id}` });
      },
      iterator: async ({ send, date }) => {
        await redis.setex(presenceKey, env.DEV_PRESENCE_TTL_MS / 1000, date.toISOString());

        send({ event: "time", data: new Date().toISOString() });
      },
      cleanup: async () => {
        await redis.del(presenceKey);

        // Publish disconnect event
        await redis.publish(
          presenceChannel,
          JSON.stringify({
            type: "disconnected",
            environmentId,
            timestamp: Date.now(),
          })
        );
      },
    };
  },
});
