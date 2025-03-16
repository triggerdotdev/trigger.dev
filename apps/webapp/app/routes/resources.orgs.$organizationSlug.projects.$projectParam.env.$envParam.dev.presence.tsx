import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { env } from "~/env.server";
import { DevPresenceStream } from "~/presenters/v3/DevPresenceStream.server";
import { logger } from "~/services/logger.server";
import { createSSELoader, type SendFunction } from "~/utils/sse";
import Redis from "ioredis";

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_TTL_MS,
  interval: env.DEV_PRESENCE_POLL_INTERVAL_MS,
  debug: true,
  handler: async ({ id, controller, debug, request, params }) => {
    const userId = await requireUserId(request);
    const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
        slug: envParam,
        type: "DEVELOPMENT",
        project: {
          slug: projectParam,
        },
        organization: {
          slug: organizationSlug,
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const presenceKey = DevPresenceStream.getPresenceKey(environment.id);
    const presenceChannel = DevPresenceStream.getPresenceChannel(environment.id);

    // Create two Redis clients - one for subscribing and one for regular commands
    const redisConfig = {
      port: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PORT ?? undefined,
      host: env.RUN_ENGINE_DEV_PRESENCE_REDIS_HOST ?? undefined,
      username: env.RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME ?? undefined,
      password: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    };

    // Subscriber client for pubsub
    const subRedis = new Redis(redisConfig);

    // Command client for regular Redis commands
    const cmdRedis = new Redis(redisConfig);

    const checkAndSendPresence = async (send: SendFunction) => {
      try {
        // Use the command client for the GET operation
        const currentPresenceValue = await cmdRedis.get(presenceKey);
        const isConnected = !!currentPresenceValue;

        // Format lastSeen as ISO string if it exists
        let lastSeen = null;
        if (currentPresenceValue) {
          // Check if it's a numeric timestamp
          if (!isNaN(Number(currentPresenceValue))) {
            // Convert numeric timestamp to ISO string
            lastSeen = new Date(parseInt(currentPresenceValue, 10)).toISOString();
          } else {
            // It's already a string format, make sure it's ISO
            try {
              lastSeen = new Date(currentPresenceValue).toISOString();
            } catch (e) {
              // If parsing fails, use current time as fallback
              lastSeen = new Date().toISOString();
              logger.warn("Failed to parse lastSeen value, using current time", {
                originalValue: currentPresenceValue,
              });
            }
          }
        }

        send({
          event: "presence",
          data: JSON.stringify({
            type: isConnected ? "connected" : "disconnected",
            environmentId: environment.id,
            timestamp: new Date().toISOString(), // Also standardize this to ISO
            lastSeen: lastSeen,
          }),
        });

        return isConnected;
      } catch (error) {
        // Handle the case where the controller is closed
        logger.debug("Failed to send presence data, stream might be closed", { error });
        return false;
      }
    };

    return {
      beforeStream: async () => {
        logger.debug("Start dev presence listening SSE session", {
          environmentId: environment.id,
          presenceChannel,
        });
      },
      initStream: async ({ send }) => {
        await checkAndSendPresence(send);

        //start subscribing with the subscriber client
        await subRedis.subscribe(presenceChannel);

        subRedis.on("message", async (channel, message) => {
          if (channel === presenceChannel) {
            try {
              await checkAndSendPresence(send);
            } catch (error) {
              logger.error("Failed to parse presence message", { error, message });
            }
          }
        });

        send({ event: "time", data: new Date().toISOString() });
      },
      iterator: async ({ send, date }) => {
        await checkAndSendPresence(send);
      },
      cleanup: async ({ send }) => {
        await checkAndSendPresence(send);

        await subRedis.unsubscribe(presenceChannel);
        await subRedis.quit();
        await cmdRedis.quit();
      },
    };
  },
});
