import { json, TypedResponse } from "@remix-run/server-runtime";
import { RunId } from "@trigger.dev/core/v3/isomorphic";
import { WorkerApiRunLatestSnapshotResponseBody } from "@trigger.dev/core/v3/workers";
import { z } from "zod";
import { prisma } from "~/db.server";
import { logger } from "~/services/logger.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { engine } from "~/v3/runEngine.server";

export const loader = createLoaderApiRoute(
  {
    findResource: async () => 1,
    params: z.object({
      runFriendlyId: z.string(),
    }),
  },
  async ({
    authentication,
    params,
  }): Promise<TypedResponse<WorkerApiRunLatestSnapshotResponseBody>> => {
    logger.debug("dev: Get latest snapshot", {
      environmentId: authentication.environment.id,
      params,
    });

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

      const executionData = await engine.getRunExecutionData({
        runId: RunId.toId(params.runFriendlyId),
      });

      if (!executionData) {
        throw new Error("Failed to retrieve latest snapshot");
      }

      return json({ execution: executionData });
    } catch (error) {
      logger.error("Failed to get latest snapshot", {
        environmentId: authentication.environment.id,
        error,
      });
      throw error;
    }
  }
);
