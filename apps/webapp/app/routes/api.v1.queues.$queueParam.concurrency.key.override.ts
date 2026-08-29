import { json } from "@remix-run/server-runtime";
import { type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { toQueueItem } from "~/presenters/v3/QueueRetrievePresenter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";

const BodySchema = z.object({
  type: RetrieveQueueType.default("id"),
  concurrencyKey: z.string().min(1).max(128),
  concurrencyLimit: z.number().int().min(0).max(100000),
});

const route = createActionApiRoute(
  {
    body: BodySchema,
    params: z.object({
      queueParam: z.string().transform((val) => val.replace(/%2F/g, "/")),
    }),
    authorization: {
      action: "write",
      resource: () => ({ type: "queues" }),
    },
  },
  async ({ params, body, authentication }) => {
    const input: RetrieveQueueParam =
      body.type === "id"
        ? params.queueParam
        : {
            type: body.type,
            name: decodeURIComponent(params.queueParam).replace(/%2F/g, "/"),
          };

    return concurrencySystem.queues
      .overrideConcurrencyKeyLimit(
        authentication.environment,
        input,
        body.concurrencyKey,
        body.concurrencyLimit
      )
      .match(
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
            case "invalid_override":
            case "concurrency_limit_exceeds_maximum":
            case "too_many_key_overrides": {
              return json({ error: error.message }, { status: 400 });
            }
            case "queue_update_failed": {
              return json(
                { error: "Failed to update queue concurrency key limit" },
                { status: 500 }
              );
            }
            case "sync_queue_concurrency_to_engine_failed": {
              return json({ error: "Failed to sync the concurrency key limit" }, { status: 500 });
            }
            case "get_queue_stats_failed": {
              return json({ error: "Failed to read queue stats" }, { status: 500 });
            }
            case "other": {
              return json(
                { error: "Failed to update queue concurrency key limit" },
                {
                  status: 500,
                }
              );
            }
            default: {
              return json(
                { error: "Failed to update queue concurrency key limit" },
                {
                  status: 500,
                }
              );
            }
          }
        }
      );
  }
);

export const { action } = route;
