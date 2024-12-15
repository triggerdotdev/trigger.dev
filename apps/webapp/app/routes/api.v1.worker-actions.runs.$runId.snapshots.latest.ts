import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiRunLatestSnapshotResponseBody } from "@trigger.dev/worker";
import { z } from "zod";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      runId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkerApiRunLatestSnapshotResponseBody>> => {
    const { runId } = params;

    const executionData = await authenticatedWorker.getLatestSnapshot({
      runId,
    });

    if (!executionData) {
      throw new Error("Failed to retrieve latest snapshot");
    }

    return json({ execution: executionData });
  }
);
