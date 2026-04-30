import { json } from "@remix-run/server-runtime";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { extractAISpanData } from "~/components/runs/v3/ai";
import { createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";

const ParamsSchema = z.object({
  runId: z.string(),
  spanId: z.string(),
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
  async ({ params, resource: run, authentication }) => {
    const eventRepository = resolveEventRepositoryForStore(
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

    const triggeredRuns = await $replica.taskRun.findMany({
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
    });

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
