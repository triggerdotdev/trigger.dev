import { json } from "@remix-run/server-runtime";
import { type QueueItem } from "@trigger.dev/core/v3";
import { z } from "zod";
import { QueueListPresenter } from "~/presenters/v3/QueueListPresenter.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const SearchParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional(),
});

export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParamsSchema,
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
  },
  async ({ searchParams, authentication }) => {
    const service = new QueueListPresenter(searchParams.perPage);

    try {
      const result = await service.call({
        environment: authentication.environment,
        page: searchParams.page ?? 1,
      });

      if (!result.success) {
        return json({ error: result.code }, { status: 400 });
      }

      const queues: QueueItem[] = result.queues;
      return json({ data: queues, pagination: result.pagination }, { status: 200 });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }

      return json(
        { error: error instanceof Error ? error.message : "Internal Server Error" },
        { status: 500 }
      );
    }
  }
);
