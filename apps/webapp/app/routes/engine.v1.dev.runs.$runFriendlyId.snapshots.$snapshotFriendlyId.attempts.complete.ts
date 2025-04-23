import { json, TypedResponse } from "@remix-run/server-runtime";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import {
  WorkerApiRunAttemptCompleteRequestBody,
  WorkerApiRunAttemptCompleteResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    body: WorkerApiRunAttemptCompleteRequestBody,
    method: "POST",
  },
  async ({
    authentication,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiRunAttemptCompleteResponseBody>> => {
    const { completion } = body;
    const { runFriendlyId, snapshotFriendlyId } = params;

    try {
      const run = await prisma.taskRun.findFirst({
        where: {
          friendlyId: params.runFriendlyId,
          runtimeEnvironmentId: authentication.environment.id,
        },
      });

      if (!run) {
        throw new Response("You don't have permissions for this run", { status: 401 });
      }

      const completeResult = await engine.completeRunAttempt({
        runId: RunId.toId(runFriendlyId),
        snapshotId: SnapshotId.toId(snapshotFriendlyId),
        completion,
      });

      return json({ result: completeResult });
    } catch (error) {
      logger.error("Failed to complete dev attempt", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

export { action };
