import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { isPendingUnitInProgress } from "@internal/run-store";
import type { WorkerApiRunLatestSnapshotResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
    }),
    workerActionToken: "snapshots_latest",
  },
  async ({
    authenticatedWorker,
    params,
    environmentId,
  }): Promise<TypedResponse<WorkerApiRunLatestSnapshotResponseBody | { error: string }>> => {
    const { runFriendlyId } = params;

    let executionData: Awaited<ReturnType<typeof authenticatedWorker.getLatestSnapshot>>;
    try {
      executionData = await authenticatedWorker.getLatestSnapshot({ runFriendlyId, environmentId });
    } catch (error) {
      // Returned, not thrown: the route builder logs every thrown value as an error.
      if (isPendingUnitInProgress(error)) {
        return json({ error: "Snapshot read temporarily unavailable" }, { status: 503 });
      }
      throw error;
    }

    if (!executionData) {
      throw new Error("Failed to retrieve latest snapshot");
    }

    return json({ execution: executionData });
  }
);
