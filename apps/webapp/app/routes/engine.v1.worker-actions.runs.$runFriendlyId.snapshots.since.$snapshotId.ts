import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { SnapshotReadUnavailableError } from "@internal/run-store";
import type { WorkerApiRunSnapshotsSinceResponseBody } from "@trigger.dev/core/v3/workers";
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
    environmentId,
  }): Promise<TypedResponse<WorkerApiRunSnapshotsSinceResponseBody | { error: string }>> => {
    const { runFriendlyId, snapshotId } = params;

    let snapshots: Awaited<ReturnType<typeof authenticatedWorker.getSnapshotsSince>>;
    try {
      snapshots = await authenticatedWorker.getSnapshotsSince({
        runFriendlyId,
        snapshotId,
        environmentId,
      });
    } catch (error) {
      // Returned, not thrown: the route builder logs every thrown value as an error.
      if (error instanceof SnapshotReadUnavailableError && error.retriable) {
        return json({ error: "Snapshot read temporarily unavailable" }, { status: 503 });
      }
      throw error;
    }

    if (!snapshots) {
      throw new Error("Failed to retrieve snapshots since given snapshot");
    }

    return json({ snapshots });
  }
);
