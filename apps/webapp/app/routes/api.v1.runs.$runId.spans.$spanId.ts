import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { extractAISpanData } from "~/components/runs/v3/ai";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { buildSyntheticSpanDetailBody } from "~/v3/mollifier/syntheticApiResponses.server";
import { runStore } from "~/v3/runStore.server";

const ParamsSchema = z.object({
  runId: z.string(),
  spanId: z.string(),
});

// Resolve the run from either Postgres or the mollifier buffer.
// Buffered runs only have one valid spanId (the queued span recorded at
// gate time and reused as the run's root spanId when the drainer
// materialises). Any other spanId returns a deterministic 404; the queued
// span returns a minimal synthesised shape so the customer's SDK sees the
// same 200 contract they'd get for a freshly-triggered run.
type ResolvedRun =
  | { source: "pg"; run: Awaited<ReturnType<typeof findPgRun>> & {} }
  | {
      source: "buffer";
      run: NonNullable<Awaited<ReturnType<typeof findRunByIdWithMollifierFallback>>>;
    };

async function findPgRun(runId: string, environmentId: string) {
  return runStore.findRun({ friendlyId: runId, runtimeEnvironmentId: environmentId }, $replica);
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
  async ({ params, resource: resolved, authentication }) => {
    if (resolved.source === "buffer") {
      // Buffered runs have exactly one valid spanId — the queued span the
      // mollifier gate recorded at trigger time, which becomes the run's
      // root spanId once the drainer materialises. Any other spanId is a
      // deterministic 404. The matching spanId returns a minimal shape
      // representing "span exists, no execution data yet."
      if (resolved.run.spanId !== params.spanId) {
        return json({ error: "Span not found" }, { status: 404 });
      }
      return json(buildSyntheticSpanDetailBody(resolved.run), { status: 200 });
    }

    const run = resolved.run;
    const eventRepository = await getEventRepositoryForStore(
      run.taskEventStore,
      authentication.environment.organization.id
    );
    const eventStore = getTaskEventStoreTableForRun(run);

    const span = await eventRepository.getSpan(
      eventStore,
      authentication.environment.id,
      params.spanId,
      run.traceId,
      run.createdAt,
      run.completedAt ?? undefined
    );

    if (!span) {
      return json({ error: "Span not found" }, { status: 404 });
    }

    // Duration is nanoseconds from ClickHouse (Postgres store is deprecated)
    const durationMs = span.duration / 1_000_000;

    const aiData =
      span.properties && typeof span.properties === "object"
        ? extractAISpanData(span.properties as Record<string, unknown>, durationMs)
        : undefined;

    const triggeredRuns = await runStore.findRuns(
      {
        take: 50,
        select: {
          friendlyId: true,
          taskIdentifier: true,
          status: true,
          createdAt: true,
        },
        where: {
          runtimeEnvironmentId: authentication.environment.id,
          parentSpanId: params.spanId,
        },
      },
      $replica
    );

    const properties =
      span.properties &&
      typeof span.properties === "object" &&
      Object.keys(span.properties as Record<string, unknown>).length > 0
        ? (span.properties as Record<string, unknown>)
        : undefined;

    return json(
      {
        spanId: span.spanId,
        parentId: span.parentId,
        runId: run.friendlyId,
        message: span.message,
        isError: span.isError,
        isPartial: span.isPartial,
        isCancelled: span.isCancelled,
        level: span.level,
        startTime: span.startTime,
        durationMs,
        properties,
        events: span.events?.length ? span.events : undefined,
        entityType: span.entity.type ?? undefined,
        ai: aiData
          ? {
              model: aiData.model,
              provider: aiData.provider,
              operationName: aiData.operationName,
              inputTokens: aiData.inputTokens,
              outputTokens: aiData.outputTokens,
              totalTokens: aiData.totalTokens,
              cachedTokens: aiData.cachedTokens,
              reasoningTokens: aiData.reasoningTokens,
              inputCost: aiData.inputCost,
              outputCost: aiData.outputCost,
              totalCost: aiData.totalCost,
              cachedCost: aiData.cachedCost,
              cacheCreationCost: aiData.cacheCreationCost,
              tokensPerSecond: aiData.tokensPerSecond,
              msToFirstChunk: aiData.msToFirstChunk,
              durationMs: aiData.durationMs,
              finishReason: aiData.finishReason,
              responseText: aiData.responseText,
            }
          : undefined,
        triggeredRuns:
          triggeredRuns.length > 0
            ? triggeredRuns.map((r) => ({
                runId: r.friendlyId,
                taskIdentifier: r.taskIdentifier,
                status: r.status,
                createdAt: r.createdAt,
              }))
            : undefined,
      },
      { status: 200 }
    );
  }
);
