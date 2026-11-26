import type { TypedResponse } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { isPendingUnitInProgress } from "@internal/run-store";
import { RunId, SnapshotId } from "@trigger.dev/core/v3/isomorphic";
import type { WorkloadHeartbeatResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { devWorkerAuthorization } from "~/services/devWorkerAuthorization.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";
import { runStore } from "~/v3/runStore.server";

const { action } = createActionApiRoute(
  {
    authorization: devWorkerAuthorization,
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
  }): Promise<TypedResponse<WorkloadHeartbeatResponseBody | { error: string }>> => {
    const { runFriendlyId, snapshotFriendlyId } = params;

    try {
      const run = await runStore.findRun(
        {
          friendlyId: params.runFriendlyId,
          runtimeEnvironmentId: authentication.environment.id,
        },
        prisma
      );

      if (!run) {
        throw new Response("You don't have permissions for this run", { status: 401 });
      }

      await engine.heartbeatRun({
        runId: RunId.toId(runFriendlyId),
        snapshotId: SnapshotId.toId(snapshotFriendlyId),
        organizationId: authentication.environment.organizationId,
      });

      return json({ ok: true });
    } catch (error) {
      // Returned, not thrown: the route builder logs every thrown value as an error.
      if (isPendingUnitInProgress(error)) {
        return json({ error: "Snapshot read temporarily unavailable" }, { status: 503 });
      }
      logger.error("Failed to heartbeat dev run", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);

export { action };
