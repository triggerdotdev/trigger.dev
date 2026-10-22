import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { WorkerApiContinueRunExecutionRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { continueRunErrorResponse } from "~/utils/continueRunErrors.server";

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
    runnerId,
    environmentId,
  }): Promise<TypedResponse<WorkerApiContinueRunExecutionRequestBody>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    logger.debug("Continuing run execution", { runFriendlyId, snapshotFriendlyId });

    try {
      const continuationResult = await authenticatedWorker.continueRunExecution({
        runFriendlyId,
        snapshotFriendlyId,
        runnerId,
        environmentId,
      });

      return json(continuationResult);
    } catch (error) {
      // An authorization rejection is thrown as a Response; propagate it as-is rather than
      // masking it as a generic 422.
      if (error instanceof Response) {
        throw error;
      }

      logger.warn("Failed to continue run execution", {
        runFriendlyId,
        snapshotFriendlyId,
        error,
        environmentId,
      });

      // A 422 is non-retryable, so the worker would permanently abort a run over a
      // database blip. Temporary errors get a status the worker retries instead.
      const response = continueRunErrorResponse(error, {
        retryableErrors: env.RUN_ENGINE_CONTINUE_RETRYABLE_ERRORS_ENABLED,
      });

      // No response: the generic 500 handler takes it and scrubs the message.
      if (!response) {
        throw error;
      }

      throw response;
    }
  }
);
