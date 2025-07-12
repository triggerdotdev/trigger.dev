import { BulkActionStatus } from "@trigger.dev/database";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { devPresence } from "~/presenters/v3/DevPresence.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema, ProjectParamSchema } from "~/utils/pathBuilder";
import { createSSELoader, type SendFunction } from "~/utils/sse";

const Params = EnvironmentParamSchema.extend({
  bulkActionParam: z.string(),
});

export const loader = createSSELoader({
  timeout: env.DEV_PRESENCE_SSE_TIMEOUT,
  interval: env.DEV_PRESENCE_POLL_MS,
  debug: false,
  handler: async ({ id, controller, debug, request, params }) => {
    const userId = await requireUserId(request);
    const { organizationSlug, projectParam, envParam, bulkActionParam } = Params.parse(params);

    const environment = await $replica.runtimeEnvironment.findFirst({
      where: {
        id: envParam,
        project: {
          slug: projectParam,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    if (!environment) {
      throw new Response("Not Found", { status: 404 });
    }

    const getBulkActionProgress = async (send: SendFunction) => {
      try {
        const bulkAction = await $replica.bulkActionGroup.findFirst({
          select: {
            status: true,
            successCount: true,
            failureCount: true,
          },
          where: {
            friendlyId: bulkActionParam,
            environmentId: environment.id,
          },
        });

        send({
          event: "progress",
          data: JSON.stringify({
            status: bulkAction?.status,
            successCount: bulkAction?.successCount,
            failureCount: bulkAction?.failureCount,
          }),
        });

        return bulkAction;
      } catch (error) {
        // Handle the case where the controller is closed
        logger.debug("Failed to send bulk action progress data, stream might be closed", { error });
        return null;
      }
    };

    return {
      beforeStream: async () => {
        logger.debug("Start dev presence listening SSE session", {
          environmentId: environment.id,
        });
      },
      initStream: async ({ send }) => {
        const bulkAction = await getBulkActionProgress(send);

        send({ event: "time", data: new Date().toISOString() });

        if (bulkAction?.status !== BulkActionStatus.PENDING) {
          return false;
        }

        return true;
      },
      iterator: async ({ send, date }) => {
        const bulkAction = await getBulkActionProgress(send);

        if (bulkAction?.status !== BulkActionStatus.PENDING) {
          return false;
        }

        return true;
      },
      cleanup: async ({ send }) => {
        await getBulkActionProgress(send);
      },
    };
  },
});
