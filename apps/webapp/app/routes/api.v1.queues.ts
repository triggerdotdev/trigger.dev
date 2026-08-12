import { json } from "@remix-run/server-runtime";
import { type QueueItem } from "@trigger.dev/core/v3";
import { z } from "zod";
import {
  QUEUE_LIST_DEFAULT_ITEMS_PER_PAGE,
  QueueListPresenter,
} from "~/presenters/v3/QueueListPresenter.server";
import { toOffsetLimitQueueListPagination } from "~/presenters/v3/queueListPagination.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { determineEngineVersion } from "~/v3/engineVersion.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const SearchParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce
    .number()
    .int()
    .positive()
    .transform((n) => Math.min(n, 100))
    .optional(),
});

export const loader = createLoaderApiRoute(
  {
    searchParams: SearchParamsSchema,
    findResource: async () => 1, // This is a dummy function, we don't need to find a resource
    authorization: { action: "read", resource: () => ({ type: "queues" }) },
  },
  async ({ searchParams, authentication }) => {
    const service = new QueueListPresenter(searchParams.perPage);

    try {
      // v3 (engine V1) has no V2 queues to list, so old clients get a clean 400.
      const engineVersion = await determineEngineVersion({
        environment: authentication.environment,
      });

      if (engineVersion === "V1") {
        return json({ error: "engine-version" }, { status: 400 });
      }

      const result = await service.call({
        environment: authentication.environment,
        page: searchParams.page ?? 1,
      });

      const queues: QueueItem[] = result.queues;
      return json(
        {
          data: queues,
          pagination: toOffsetLimitQueueListPagination(result.pagination, {
            itemsOnPage: queues.length,
            perPage: searchParams.perPage ?? QUEUE_LIST_DEFAULT_ITEMS_PER_PAGE,
          }),
        },
        { status: 200 }
      );
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }

      logger.error("Failed to list queues", { error });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
