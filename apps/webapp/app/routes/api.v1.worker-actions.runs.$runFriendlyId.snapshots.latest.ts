import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiRunLatestSnapshotResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkerApiRunLatestSnapshotResponseBody>> => {
    const { runFriendlyId } = params;

    const executionData = await authenticatedWorker.getLatestSnapshot({
      runFriendlyId,
    });

    if (!executionData) {
      throw new Error("Failed to retrieve latest snapshot");
    }

    return json({ execution: executionData });
  }
);
