import { json, TypedResponse } from "@remix-run/server-runtime";
import {
  WorkerApiSuspendRunRequestBody,
  WorkerApiSuspendRunResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createActionWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const action = createActionWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    body: WorkerApiSuspendRunRequestBody,
  },
  async ({
    authenticatedWorker,
    params,
    body,
    runnerId,
  }): Promise<TypedResponse<WorkerApiSuspendRunResponseBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    logger.debug("Suspending run", { runFriendlyId, snapshotFriendlyId, body });

    if (!body.success) {
      logger.error("Failed to suspend run", {
        runFriendlyId,
        snapshotFriendlyId,
        error: body.error,
      });

      return json({ ok: true });
    }

    try {
      await authenticatedWorker.createCheckpoint({
        runFriendlyId,
        snapshotFriendlyId,
        checkpoint: body.checkpoint,
        runnerId,
      });

      return json({ ok: true });
    } catch (error) {
      logger.error("Failed to suspend run", { runFriendlyId, snapshotFriendlyId, error });
      throw error;
    }
  }
);
