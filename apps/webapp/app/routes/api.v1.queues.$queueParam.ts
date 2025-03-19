import { json } from "@remix-run/server-runtime";
import { type QueueItem, type RetrieveQueueParam, RetrieveQueueType } from "@trigger.dev/core/v3";
import { z } from "zod";
import { QueueRetrievePresenter } from "~/presenters/v3/QueueRetrievePresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";

const SearchParamsSchema = z.object({
  type: RetrieveQueueType.default("id"),
});

export const loader = createLoaderApiRoute(
  {
    params: z.object({
      queueParam: z.string().transform((val) => val.replace(/%2F/g, "/")),
    }),
    searchParams: SearchParamsSchema,
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ params, searchParams, authentication }) => {
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
      if (result.code === "queue-not-found") {
        return json({ error: result.code }, { status: 404 });
      }

      return json({ error: result.code }, { status: 400 });
    }

    const q: QueueItem = result.queue;
    return json(q);
  }
);
