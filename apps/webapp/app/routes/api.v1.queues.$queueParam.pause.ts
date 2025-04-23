import { json } from "@remix-run/server-runtime";
import { type QueueItem, type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { PauseQueueService } from "~/v3/services/pauseQueue.server";

const BodySchema = z.object({
  type: RetrieveQueueType.default("id"),
  action: z.enum(["pause", "resume"]),
});

export const { action } = createActionApiRoute(
  {
    body: BodySchema,
    params: z.object({
      queueParam: z.string().transform((val) => val.replace(/%2F/g, "/")),
    }),
  },
  async ({ params, body, authentication }) => {
    const input: RetrieveQueueParam =
      body.type === "id"
        ? params.queueParam
        : {
            type: body.type,
            name: decodeURIComponent(params.queueParam).replace(/%2F/g, "/"),
          };

    const service = new PauseQueueService();
    const result = await service.call(
      authentication.environment,
      input,
      body.action === "pause" ? "paused" : "resumed"
    );

    if (!result.success) {
      if (result.code === "queue-not-found") {
        return json({ error: result.code }, { status: 404 });
      }

      return json({ error: result.code }, { status: 400 });
    }

    const q: QueueItem = result.queue;
    return json(q);
  }
);
