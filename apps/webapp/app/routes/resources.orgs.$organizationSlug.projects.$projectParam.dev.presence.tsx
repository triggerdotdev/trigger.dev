import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { ProjectParamSchema } from "~/utils/pathBuilder";
import { createSSELoader, type SendFunction } from "~/utils/sse";

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_SSE_TIMEOUT,
  interval: env.DEV_PRESENCE_POLL_MS,
  debug: false,
  handler: async ({ id, controller, debug, request, params }) => {
    const userId = await requireUserId(request);
    const { organizationSlug, projectParam } = ProjectParamSchema.parse(params);

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
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

    const checkAndSendPresence = async (send: SendFunction) => {
      try {
        // Use the command client for the GET operation
        const isConnected = await devPresence.isConnected(environment.id);

        send({
          event: "presence",
          data: JSON.stringify({
            isConnected,
            environmentId: environment.id,
            timestamp: new Date().toISOString(),
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
      },
    };
  },
});
