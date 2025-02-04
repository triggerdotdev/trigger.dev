import { json, TypedResponse } from "@remix-run/server-runtime";
import { assertExhaustive } from "@trigger.dev/core";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/apps";
import {
  WorkerApiDebugLogBody,
  WorkerApiRunAttemptStartResponseBody,
  WorkerApiWaitForDurationRequestBody,
  WorkerApiWaitForDurationResponseBody,
  WorkloadHeartbeatResponseBody,
} from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { recordRunDebugLog } from "~/v3/eventRepository.server";
import { engine } from "~/v3/runEngine.server";

const { action } = createActionApiRoute(
  {
    body: WorkerApiWaitForDurationRequestBody,
    params: z.object({
      runFriendlyId: z.string(),
      snapshotFriendlyId: z.string(),
    }),
    method: "POST",
  },
  async ({
    authentication,
    body,
    params,
  }): Promise<TypedResponse<WorkerApiWaitForDurationResponseBody>> => {
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

      const waitResult = await engine.waitForDuration({
        runId: RunId.toId(runFriendlyId),
        snapshotId: SnapshotId.toId(snapshotFriendlyId),
        date: body.date,
      });

      return json(waitResult);
    } catch (error) {
      logger.error("Failed to wait for duration dev", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

export { action };
