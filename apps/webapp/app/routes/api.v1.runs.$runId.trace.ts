import { trace } from "@opentelemetry/api";
import { json } from "@remix-run/server-runtime";
import type { RetrieveRunTracePageResponseBody } from "@trigger.dev/core/v3";
import { BatchId } from "@trigger.dev/core/v3/isomorphic";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { anyResource, createLoaderApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { clampToEmergencySpanCap } from "~/v3/eventRepository/emergencySpanCap.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTraceInsertedAtEnd } from "~/v3/eventRepository/traceInsertedAtBound";
import { getRunTracePage } from "~/v3/eventRepository/runTracePage.server";
import { FEATURE_FLAG } from "~/v3/featureFlags";
import { makeFlag } from "~/v3/featureFlags.server";
import { toPageSpan } from "~/v3/eventRepository/tracePage";
import {
  DEFAULT_TRACE_PAGE_SIZE,
  parseTracePageRequest,
  type TracePageRequest,
} from "~/v3/eventRepository/tracePageRequest";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { findRunByIdWithMollifierFallback } from "~/v3/mollifier/readFallback.server";
import { buildSyntheticTraceBody } from "~/v3/mollifier/syntheticApiResponses.server";
import { runStore } from "~/v3/runStore.server";

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
  async ({ resource: resolved, authentication, request }) => {
    const searchParams = new URL(request.url).searchParams;

    if (
      hasPageParams(searchParams) &&
      (await isTracePagingEnabled(authentication.environment.organization.featureFlags))
    ) {
      const pageRequest = parseTracePageRequest(searchParams, DEFAULT_TRACE_PAGE_SIZE);
      if (pageRequest.isErr()) {
        return json({ error: PAGE_REQUEST_ERRORS[pageRequest.error] }, { status: 400 });
      }
      if (pageRequest.value) {
        return tracePageResponse(resolved, authentication.environment, pageRequest.value);
      }
    }

    if (resolved.source === "buffer") {
      // Buffered runs have no events ingested yet — the drainer hasn't
      // materialised the PG row and the worker hasn't started executing.
      // The helper synthesises a single root span that satisfies the SDK's
      // RetrieveRunTraceResponseBody schema (rootSpan is non-nullable) and
      // reflects the buffered terminal state.
      return json(buildSyntheticTraceBody(resolved.run), { status: 200 });
    }

    const run = resolved.run;
    const eventRepository = await getEventRepositoryForStore(
      run.taskEventStore,
      authentication.environment.organization.id
    );

    const traceSummary = await eventRepository.getTraceDetailedSubtreeSummary(
      getTaskEventStoreTableForRun(run),
      authentication.environment.id,
      run.traceId,
      run.spanId,
      run.createdAt,
      run.completedAt ?? undefined,
      { insertedAtEnd: getTraceInsertedAtEnd(run) }
    );

    trace.getActiveSpan()?.setAttributes({
      "run.depth": run.depth,
      "trace.truncated": traceSummary?.isTruncated ?? false,
    });

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

function hasPageParams(searchParams: URLSearchParams): boolean {
  return searchParams.has("page[size]") || searchParams.has("page[after]");
}

// Off: page parameters are ignored and the request gets today's tree response.
function isTracePagingEnabled(orgFeatureFlags: unknown): Promise<boolean> {
  return makeFlag()({
    key: FEATURE_FLAG.publicTracePagingEnabled,
    defaultValue: false,
    overrides: (orgFeatureFlags as Record<string, unknown>) ?? {},
  });
}

const PAGE_REQUEST_ERRORS = {
  invalid_page_size: "page[size] must be a positive integer",
  invalid_cursor: "page[after] is not a valid cursor; pass back pagination.next unchanged",
} as const;

const CHILD_RUN_ERROR =
  "Paging is only supported for runs at the root of their trace. Request this run's trace without page parameters.";

// The same synthetic root span the unpaged response returns for a run still in the trigger buffer.
function bufferedRunPage(
  run: Parameters<typeof buildSyntheticTraceBody>[0]
): RetrieveRunTracePageResponseBody {
  if (!run.spanId) {
    return { data: [], attemptFailures: [], pagination: {} };
  }

  const { rootSpan } = buildSyntheticTraceBody(run).trace;
  return { data: [toPageSpan(rootSpan)], attemptFailures: [], pagination: {} };
}

async function tracePageResponse(
  resolved: ResolvedRun,
  environment: { id: string; organization: { id: string } },
  pageRequest: TracePageRequest
) {
  // Paging reads the whole trace, so the run's span must be the trace root (no parent run or span).
  if (resolved.run.parentTaskRunId || resolved.run.parentSpanId) {
    return json({ error: CHILD_RUN_ERROR }, { status: 400 });
  }

  if (resolved.source === "buffer") {
    return json(bufferedRunPage(resolved.run), { status: 200 });
  }

  const capped = env.TRACE_VIEW_EMERGENCY_SPAN_CAP !== undefined;
  if (capped && pageRequest.after) {
    return json(
      { error: "Trace paging is temporarily limited to the first page" },
      { status: 503, headers: { "Retry-After": "60", "x-should-retry": "false" } }
    );
  }

  const run = resolved.run;
  const page = await getRunTracePage({
    repository: await getEventRepositoryForStore(run.taskEventStore, environment.organization.id),
    storeTable: getTaskEventStoreTableForRun(run),
    environmentId: environment.id,
    run,
    pageRequest: { ...pageRequest, limit: clampToEmergencySpanCap(pageRequest.limit) },
    // Like the dashboard, stop paging under the emergency cap instead of reading the whole trace.
    stopAfterPage: capped,
  });

  if (page.isOk()) {
    return json(page.value, { status: 200 });
  }

  switch (page.error) {
    case "store_unavailable":
      // The SDK retries 5xx; tell it not to, so a struggling store isn't hit harder.
      return json(
        { error: "The trace store is temporarily unavailable" },
        { status: 503, headers: { "Retry-After": "5", "x-should-retry": "false" } }
      );
    case "paging_unsupported":
      return json(
        { error: "Trace paging isn't supported by this deployment's trace store" },
        { status: 501 }
      );
  }
}
