import { json, TypedResponse } from "@remix-run/server-runtime";
import { WorkerApiContinueRunExecutionRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";

export const loader = createLoaderWorkerApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
  },
  async ({
    authenticatedWorker,
    params,
  }): Promise<TypedResponse<WorkerApiContinueRunExecutionRequestBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    logger.debug("Continuing run execution", { runFriendlyId, snapshotFriendlyId });

    try {
      const continuationResult = await authenticatedWorker.continueRunExecution({
        runFriendlyId,
        snapshotFriendlyId,
      });

      return json(continuationResult);
    } catch (error) {
      logger.warn("Failed to suspend run", { runFriendlyId, snapshotFriendlyId, error });
      if (error instanceof Error) {
        throw json({ error: error.message }, { status: 422 });
      }

      throw json({ error: "Failed to continue run execution" }, { status: 422 });
    }
  }
);
