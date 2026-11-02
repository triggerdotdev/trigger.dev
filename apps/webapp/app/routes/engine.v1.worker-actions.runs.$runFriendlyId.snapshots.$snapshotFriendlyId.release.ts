import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { WorkerApiRunReleaseResponseBody } from "@trigger.dev/core/v3/workers";
import { WorkerApiRunReleaseRequestBody } from "@trigger.dev/core/v3/workers";
import {
  EngineServiceValidationError,
  LatestExecutionSnapshotNotFoundError,
} from "@internal/run-engine";
import { SnapshotStateExpiredError, UnknownShardKey } from "@internal/run-store";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    body: z.compile(WorkerApiRunReleaseRequestBody),
  },
  async ({
    authenticatedWorker,
    params,
    body,
    runnerId,
    environmentId,
  }): Promise<TypedResponse<WorkerApiRunReleaseResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    let result: Awaited<ReturnType<typeof authenticatedWorker.releaseRun>>;
    try {
      result = await authenticatedWorker.releaseRun({
        runFriendlyId,
        snapshotFriendlyId,
        reason: body.reason,
        runnerId,
        environmentId,
      });
    } catch (error) {
      if (error instanceof Response) {
        throw error;
      }
      const notFound =
        (error instanceof EngineServiceValidationError && error.status === 404) ||
        error instanceof LatestExecutionSnapshotNotFoundError ||
        error instanceof SnapshotStateExpiredError ||
        error instanceof UnknownShardKey;
      logger.warn(
        notFound ? "Release not applied, the run was not found" : "Failed to release run",
        {
          runFriendlyId,
          snapshotFriendlyId,
          environmentId,
          reason: body.reason,
          error,
        }
      );
      if (!notFound) {
        throw error;
      }
      // Not a 404, which clients read as a webapp without this route, nor a 500, which they retry.
      throw json(
        { error: "Run not found" },
        { status: 409, headers: { "x-should-retry": "false" } }
      );
    }

    if (!result.ok) {
      logger.info("Release not applied, the run moved on or is not this worker group's", {
        runFriendlyId,
        snapshotFriendlyId,
        environmentId,
        reason: body.reason,
        latestExecutionStatus: result.latestExecutionStatus,
      });

      // The client retries a 409 by default; a stale release will never apply, so say not to.
      throw json(
        {
          error: "The run is not at this dequeued snapshot, or this worker group does not serve it",
        },
        { status: 409, headers: { "x-should-retry": "false" } }
      );
    }

    return json({ ok: true, requeued: result.requeued });
  }
);
