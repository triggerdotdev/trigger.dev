import { json, TypedResponse } from "@remix-run/server-runtime";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import { WorkloadHeartbeatResponseBody } from "@trigger.dev/core/v3/workers";
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
    method: "POST",
  },
  async ({
    authentication,
    body,
    params,
  }): Promise<TypedResponse<WorkloadHeartbeatResponseBody>> => {
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

      await engine.heartbeatRun({
        runId: RunId.toId(runFriendlyId),
        snapshotId: SnapshotId.toId(snapshotFriendlyId),
      });

      return json({ ok: true });
    } catch (error) {
      logger.error("Failed to heartbeat dev run", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

export { action };
