import { json } from "@remix-run/server-runtime";
import { type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { toQueueItem } from "~/presenters/v3/QueueRetrievePresenter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";

const BodySchema = z.object({
  type: RetrieveQueueType.default("id"),
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

    return concurrencySystem.queues.resetConcurrencyLimit(authentication.environment, input).match(
      (queue) => {
        return json(
          toQueueItem({
            friendlyId: queue.friendlyId,
            name: queue.name,
            type: queue.type,
            running: queue.running,
            queued: queue.queued,
            concurrencyLimit: queue.concurrencyLimit,
            concurrencyLimitBase: queue.concurrencyLimitBase,
            concurrencyLimitOverriddenAt: queue.concurrencyLimitOverriddenAt,
            concurrencyLimitOverriddenBy: null,
            paused: queue.paused,
          }),
          { status: 200 }
        );
      },
      (error) => {
        switch (error.type) {
          case "queue_not_found": {
            return json({ error: "Queue not found" }, { status: 404 });
          }
          case "queue_not_overridden": {
            return json({ error: "Queue is not overridden" }, { status: 400 });
          }
          case "queue_update_failed": {
            return json({ error: "Failed to update queue concurrency limit" }, { status: 500 });
          }
          case "sync_queue_concurrency_to_engine_failed": {
            return json(
              { error: "Failed to sync queue concurrency limit to engine" },
              { status: 500 }
            );
          }
          case "get_queue_stats_failed": {
            return json({ error: "Failed to get queue stats" }, { status: 500 });
          }
          case "other":
          default: {
            error.type satisfies "other";
            return json({ error: "Internal server error" }, { status: 500 });
          }
        }
      }
    );
  }
);
