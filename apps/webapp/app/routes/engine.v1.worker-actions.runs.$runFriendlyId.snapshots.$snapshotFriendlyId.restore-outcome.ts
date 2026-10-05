import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { WorkerApiRunRestoreOutcomeResponseBody } from "@trigger.dev/core/v3/workers";
import { WorkerApiRunRestoreOutcomeRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    body: z.compile(WorkerApiRunRestoreOutcomeRequestBody),
  },
  async ({
    authenticatedWorker,
    params,
    body,
    runnerId,
    environmentId,
  }): Promise<TypedResponse<WorkerApiRunRestoreOutcomeResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    logger.debug("Reporting restore outcome", { runFriendlyId, snapshotFriendlyId, body });

    let result: Awaited<ReturnType<typeof authenticatedWorker.reportRestoreOutcome>>;
    try {
      result = await authenticatedWorker.reportRestoreOutcome({
        runFriendlyId,
        snapshotFriendlyId,
        outcome: body.outcome,
        reason: body.reason,
        message: body.message,
        snapshotRoute: body.snapshotRoute,
        runnerId,
        environmentId,
      });
    } catch (error) {
      if (error instanceof Response) {
        throw error;
      }

      logger.warn("Failed to report restore outcome", {
        runFriendlyId,
        snapshotFriendlyId,
        environmentId,
        outcome: body.outcome,
        reason: body.reason,
        error,
      });

      // Left to the generic 500 handler, which the worker's client retries.
      throw error;
    }

    if (!result.ok) {
      logger.info("Restore outcome not applied, the run has moved on", {
        runFriendlyId,
        snapshotFriendlyId,
        environmentId,
        outcome: body.outcome,
        reason: body.reason,
        latestExecutionStatus: result.latestExecutionStatus,
      });

      // The client retries a 409 by default; a stale report will never apply, so say not to.
      throw json(
        {
          error: "Snapshot is no longer the run's restore snapshot",
          latestExecutionStatus: result.latestExecutionStatus,
        },
        { status: 409, headers: { "x-should-retry": "false" } }
      );
    }

    return json({ ok: true });
  }
);
