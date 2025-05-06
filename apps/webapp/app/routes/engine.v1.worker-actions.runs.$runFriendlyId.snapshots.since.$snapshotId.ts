import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiRunSnapshotsSinceResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkerApiRunSnapshotsSinceResponseBody>> => {
    const { runFriendlyId, snapshotId } = params;

    const executions = await authenticatedWorker.getSnapshotsSince({
      runFriendlyId,
      snapshotId,
    });

    if (!executions) {
      throw new Error("Failed to retrieve snapshots since given snapshot");
    }

    return json({ executions });
  }
);
