import { $replica } from "~/db.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { env } from "~/env.server";
import { DevPresenceStream } from "~/presenters/v3/DevPresenceStream.server";
import { logger } from "~/services/logger.server";
import { createSSELoader, type SendFunction } from "~/utils/sse";
import Redis from "ioredis";

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_SSE_TIMEOUT,
  interval: env.DEV_PRESENCE_POLL_MS,
  debug: true,
  handler: async ({ id, controller, debug, request, params }) => {
    const userId = await requireUserId(request);
    const { organizationSlug, projectParam, envParam } = EnvironmentParamSchema.parse(params);

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
        slug: envParam,
        type: "DEVELOPMENT",
        orgMember: {
          userId,
        },
        project: {
          slug: projectParam,
        },
      },
    });

    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const presenceKey = DevPresenceStream.getPresenceKey(environment.id);

    const cmdRedis = new Redis({
      port: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PORT ?? undefined,
      host: env.RUN_ENGINE_DEV_PRESENCE_REDIS_HOST ?? undefined,
      username: env.RUN_ENGINE_DEV_PRESENCE_REDIS_USERNAME ?? undefined,
      password: env.RUN_ENGINE_DEV_PRESENCE_REDIS_PASSWORD ?? undefined,
      enableAutoPipelining: true,
      ...(env.RUN_ENGINE_DEV_PRESENCE_REDIS_TLS_DISABLED === "true" ? {} : { tls: {} }),
    });

    const checkAndSendPresence = async (send: SendFunction) => {
      try {
        // Use the command client for the GET operation
        const currentPresenceValue = await cmdRedis.get(presenceKey);
        const isConnected = !!currentPresenceValue;

        // Format lastSeen as ISO string if it exists
        let lastSeen = null;
        if (currentPresenceValue) {
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
          presenceKey,
        });
      },
      initStream: async ({ send }) => {
        await checkAndSendPresence(send);

        send({ event: "time", data: new Date().toISOString() });
      },
      iterator: async ({ send, date }) => {
        await checkAndSendPresence(send);
      },
      cleanup: async ({ send }) => {
        await checkAndSendPresence(send);
        await cmdRedis.quit();
      },
    };
  },
});
