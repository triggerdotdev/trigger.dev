import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";

const ParamsSchema = z.object({
  runId: z.string(), // This is the run friendly ID
});

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: (params, auth) => {
      return $replica.taskRun.findFirst({
        where: {
          friendlyId: params.runId,
          runtimeEnvironmentId: auth.environment.id,
        },
      });
    },
    shouldRetryNotFound: true,
    authorization: {
      action: "read",
      resource: (run) => ({
        runs: run.friendlyId,
        tags: run.runTags,
        batch: run.batchId ? BatchId.toFriendlyId(run.batchId) : undefined,
        tasks: run.taskIdentifier,
      }),
      superScopes: ["read:runs", "read:all", "admin"],
    },
  },
  async ({ resource: run, authentication }) => {
    const eventRepository = resolveEventRepositoryForStore(run.taskEventStore);

    const traceSummary = await eventRepository.getTraceDetailedSummary(
      getTaskEventStoreTableForRun(run),
      authentication.environment.id,
      run.traceId,
      run.createdAt,
      run.completedAt ?? undefined
    );

    if (!traceSummary) {
      return json({ error: "Trace not found" }, { status: 404 });
    }

    return json(
      {
        trace: traceSummary,
      },
      { status: 200 }
    );
  }
);
