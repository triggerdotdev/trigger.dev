import { json } from "@remix-run/server-runtime";
import { type QueueItem, type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";

const SearchParamsSchema = z.object({
  type: RetrieveQueueType.default("id"),
});

export const loader = createLoaderApiRoute(
  {
    params: z.object({
      queueParam: z.string().transform((val) => val.replace(/%2F/g, "/")),
    }),
    searchParams: SearchParamsSchema,
    // The agent's environment JWT reads a queue's own row — name, depth, limit, paused —
    // the way it already reads that queue's metrics. The `queues` scope still gates it.
    allowJWT: true,
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
    authorization: {
      action: "read",
      resource: () => ({ type: "queues" }),
    },
  },
  async ({ params, searchParams, authentication }) => {
    // v3 (engine V1) has no V2 queues to retrieve, so old clients get a clean 400.
    const engineVersion = await determineEngineVersion({
      environment: authentication.environment,
    });

    if (engineVersion === "V1") {
      return json({ error: "engine-version" }, { status: 400 });
    }

    const input: RetrieveQueueParam =
      searchParams.type === "id"
        ? params.queueParam
        : {
            type: searchParams.type,
            name: decodeURIComponent(params.queueParam).replace(/%2F/g, "/"),
          };

    const presenter = new QueueRetrievePresenter();
    const result = await presenter.call({
      environment: authentication.environment,
      queueInput: input,
    });

    if (!result.success) {
      return json({ error: result.code }, { status: 404 });
    }

    const q: QueueItem = result.queue;
    return json(q);
  }
);
