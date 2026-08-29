import { json } from "@remix-run/server-runtime";
import { type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { toQueueItem } from "~/presenters/v3/QueueRetrievePresenter.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { concurrencySystem } from "~/v3/services/concurrencySystemInstance.server";
import {
  MAX_QUEUE_OVERRIDE_PERCENT,
  MIN_QUEUE_OVERRIDE_PERCENT,
} from "~/v3/services/concurrencySystem.server";

const BodySchema = z
  .object({
    type: RetrieveQueueType.default("id"),
    // Absolute concurrency limit. Backwards compatible with existing callers.
    concurrencyLimit: z.number().int().min(0).max(100000).optional(),
    // Percentage of the environment's maximum concurrency limit (0 < percent <= 100).
    // Stored as the source of truth; the absolute limit is materialized from it.
    percent: z.number().gt(MIN_QUEUE_OVERRIDE_PERCENT).max(MAX_QUEUE_OVERRIDE_PERCENT).optional(),
  })
  .refine((body) => (body.concurrencyLimit === undefined) !== (body.percent === undefined), {
    message: "Provide exactly one of `concurrencyLimit` or `percent`",
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

    const override =
      body.percent !== undefined ? { percent: body.percent } : { limit: body.concurrencyLimit! };

    return concurrencySystem.queues
      .overrideQueueConcurrencyLimit(authentication.environment, input, override)
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
              totalConcurrencyLimit: queue.totalConcurrencyLimit,
              totalConcurrencyLimitBase: queue.totalConcurrencyLimitBase,
              totalConcurrencyLimitOverriddenAt: queue.totalConcurrencyLimitOverriddenAt,
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
            case "concurrency_limit_exceeds_maximum": {
              return json({ error: error.message }, { status: 400 });
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

export const action = route.action;
// The builder's loader answers non-POST methods with a 405
export const loader = route.loader;
