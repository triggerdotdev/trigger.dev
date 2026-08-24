import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import type { WorkerApiContinueRunExecutionRequestBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { createLoaderWorkerApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { clientSafeErrorMessage, isInfrastructureError } from "~/utils/prismaErrors";

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
      });

      // A Prisma infrastructure error (e.g. P1001 "Can't reach database
      // server") means the DB was transiently unreachable while resuming. A 422
      // is non-retryable, so the worker would permanently abort a run over a
      // blip. Let it propagate to the generic 500 handler, which scrubs the
      // message and is retried by the worker's HTTP client.
      if (isInfrastructureError(error)) {
        throw error;
      }

      if (error instanceof Error) {
        throw json({ error: clientSafeErrorMessage(error) }, { status: 422 });
      }

      throw json({ error: "Failed to continue run execution" }, { status: 422 });
    }
  }
);
