import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { readQueueGrounding } from "~/services/dashboardAgentQueueGrounding.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

/**
 * Scheduler-owned concurrency counters for one queue. `queueParam` is the queue name;
 * `?type=task` (the default) adds the `task/` prefix.
 */

const SearchParamsSchema = z.object({
  type: z.enum(["task", "custom"]).default("task"),
});

export const loader = createLoaderApiRoute(
  {
    params: z.object({
      queueParam: z.string(),
    }),
    searchParams: SearchParamsSchema,
    allowJWT: true,
    corsStrategy: "none",
    findResource: async () => 1, // dummy — the queue name is resolved in the reader
    authorization: {
      action: "read",
      resource: () => ({ type: "query", id: "queue_grounding" }),
    },
  },
  async ({ params, searchParams, authentication }) => {
    const grounding = await readQueueGrounding({
      environment: authentication.environment,
      // Remix already decoded this; decoding again would alter a name holding a literal "%2F".
      queueName: params.queueParam,
      queueType: searchParams.type,
    });

    return json(grounding);
  }
);
