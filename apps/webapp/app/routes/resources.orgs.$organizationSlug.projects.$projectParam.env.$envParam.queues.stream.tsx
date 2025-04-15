import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { requireUserId } from "~/services/session.server";
import { EnvironmentParamSchema } from "~/utils/pathBuilder";
import { createSSELoader } from "~/utils/sse";

export const loader = createSSELoader({
  timeout: env.QUEUE_SSE_AUTORELOAD_TIMEOUT_MS,
  interval: env.QUEUE_SSE_AUTORELOAD_INTERVAL_MS,
  debug: false,
  handler: async ({ request, params }) => {
    const userId = await requireUserId(request);
    const { projectParam, envParam } = EnvironmentParamSchema.parse(params);

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

    return {
      beforeStream: async () => {
        logger.debug("Start queue page SSE session", {
          environmentId: environment.id,
        });
      },
      initStream: async ({ send }) => {
        send({ event: "time", data: new Date().toISOString() });
      },
      iterator: async ({ send }) => {
        send({
          event: "update",
          data: new Date().toISOString(),
        });
      },
      cleanup: async () => {
        logger.debug("End queue page SSE session", {
          environmentId: environment.id,
        });
      },
    };
  },
});
