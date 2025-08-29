import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiDequeueResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

// Keep this route for backwards compatibility
export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      deploymentFriendlyId: z.string(),
    }),
    searchParams: z.object({
      maxRunCount: z.coerce.number().optional(),
    }),
  },
  async (): Promise<TypedResponse<WorkerApiDequeueResponseBody>> => {
    return json([]);
  }
);
