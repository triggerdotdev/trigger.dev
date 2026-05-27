import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import {
  anyResource,
  createLoaderApiRoute,
} from "~/services/routeBuilders/apiBuilder.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";

const ParamsSchema = z.object({
  runId: z.string(), // This is the run friendly ID
});

// Discriminator on the resolved resource — `pg` is the real Prisma TaskRun
// row, `buffer` is a synthesised shape from the mollifier buffer for runs
// whose drainer hasn't yet materialised them. The handler renders an empty
// trace for buffered runs so the customer sees the same 200 shape they'd
// get for a freshly-triggered PG run with no spans yet (matches the
// pass-through control case in scripts/mollifier-api-parity.sh).
type ResolvedRun =
  | { source: "pg"; run: Awaited<ReturnType<typeof findPgRun>> & {} }
  | { source: "buffer"; run: NonNullable<Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>>> };

async function findPgRun(runId: string, environmentId: string) {
  return $replica.taskRun.findFirst({
    where: { friendlyId: runId, runtimeEnvironmentId: environmentId },
  });
}

export const loader = createLoaderApiRoute(
  {
    params: ParamsSchema,
    allowJWT: true,
    corsStrategy: "all",
    findResource: async (params, auth): Promise<ResolvedRun | null> => {
      const pgRun = await findPgRun(params.runId, auth.environment.id);
      if (pgRun) return { source: "pg", run: pgRun };

      const buffered = await findRunByIdWithMollifierFallback({
        runId: params.runId,
        environmentId: auth.environment.id,
        organizationId: auth.environment.organizationId,
      });
      if (buffered) return { source: "buffer", run: buffered };

      return null;
    },
    shouldRetryNotFound: true,
    authorization: {
      action: "read",
      resource: (resolved) => {
        if (resolved.source === "pg") {
          const run = resolved.run;
          const resources = [
            { type: "runs", id: run.friendlyId },
            { type: "tasks", id: run.taskIdentifier },
            ...run.runTags.map((tag) => ({ type: "tags", id: tag })),
          ];
          if (run.batchId) {
            resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
          }
          return anyResource(resources);
        }
        const run = resolved.run;
        const resources = [
          { type: "runs", id: run.friendlyId },
          ...(run.taskIdentifier ? [{ type: "tasks", id: run.taskIdentifier }] : []),
          ...run.tags.map((tag) => ({ type: "tags", id: tag })),
        ];
        if (run.batchId) {
          resources.push({ type: "batch", id: BatchId.toFriendlyId(run.batchId) });
        }
        return anyResource(resources);
      },
    },
  },
  async ({ resource: resolved, authentication }) => {
    if (resolved.source === "buffer") {
      // Buffered runs have no events ingested yet — the drainer hasn't
      // materialised the PG row and the worker hasn't started executing.
      // Synthesise a single partial span that satisfies the SDK's
      // RetrieveRunTraceResponseBody schema (rootSpan is non-nullable).
      const buffered = resolved.run;
      return json(
        {
          trace: {
            traceId: buffered.traceId ?? "",
            rootSpan: {
              id: buffered.spanId ?? "",
              runId: buffered.friendlyId,
              data: {
                message: buffered.taskIdentifier ?? "",
                taskSlug: buffered.taskIdentifier ?? undefined,
                events: [],
                startTime: buffered.createdAt,
                duration: 0,
                isError: false,
                // Cancelled is a terminal state — the span shouldn't
                // signal "still in progress" once it's been cancelled.
                // Mirrors the sibling api.v1.runs.$runId.spans.$spanId.ts
                // and syntheticTrace.server.ts logic.
                isPartial: buffered.status !== "CANCELED",
                isCancelled: buffered.status === "CANCELED",
                level: "TRACE",
                queueName: buffered.queue ?? undefined,
                machinePreset: buffered.machinePreset ?? undefined,
              },
              children: [],
            },
          },
        },
        { status: 200 }
      );
    }

    const run = resolved.run;
    const eventRepository = await getEventRepositoryForStore(
      run.taskEventStore,
      authentication.environment.organization.id
    );

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
