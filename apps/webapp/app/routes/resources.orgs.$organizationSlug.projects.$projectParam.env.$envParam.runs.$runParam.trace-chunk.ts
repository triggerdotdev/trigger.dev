import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { TraceChunkPresenter } from "~/presenters/v3/TraceChunkPresenter.server";
import { chunkRequestKind } from "~/presenters/v3/sessionTraceRequestKind";
import { requestFeature, viewerOf, withRequestFeature } from "~/services/requestFeature.server";
import { requireUser } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import { clampToEmergencySpanCap } from "~/v3/eventRepository/emergencySpanCap.server";
import type { TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";

// Largest millisecond timestamp a JS Date can hold.
const MAX_DATE_MS = 8.64e15;

const SearchSchema = z.object({
  cursorStartTime: z.string().optional().catch(undefined),
  cursorSpanId: z.string().optional().catch(undefined),
  debug: z.literal("1").optional().catch(undefined),
  limit: z.coerce.number().int().positive().max(10_000).optional().catch(undefined),
  filter: z.literal("errors").optional().catch(undefined),
  // Live tail: only rows written at/after this time (ms since epoch).
  insertedAtSince: z.coerce
    .number()
    .int()
    .nonnegative()
    .max(MAX_DATE_MS)
    .optional()
    .catch(undefined),
  // Session view: bounds completed runs' reads by write time.
  context: z.literal("session").optional().catch(undefined),
  // Returns the run's first chunk as a trace payload instead of a chunk page.
  start: z.literal("1").optional().catch(undefined),
  // Selected span for a deep link, fetched with the first chunk.
  span: z.string().optional().catch(undefined),
});

function parseCursor(
  cursorStartTime: string | undefined,
  cursorSpanId: string | undefined
): TraceChunkCursor | undefined {
  if (cursorStartTime && cursorSpanId) {
    return { startTime: cursorStartTime, spanId: cursorSpanId };
  }
  return undefined;
}

type ChunkSearch = z.infer<typeof SearchSchema>;

export async function loader({ request, params }: LoaderFunctionArgs) {
  const url = new URL(request.url);
  const search = SearchSchema.parse(Object.fromEntries(url.searchParams));

  return withRequestFeature(search.context ? "session.trace" : "run.trace", () =>
    loadChunk(request, params, search)
  );
}

async function loadChunk(
  request: Request,
  params: LoaderFunctionArgs["params"],
  search: ChunkSearch
) {
  const user = await requireUser(request);
  const { projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);
  const {
    cursorStartTime,
    cursorSpanId,
    debug,
    limit,
    filter,
    insertedAtSince,
    context,
    start,
    span,
  } = search;

  requestFeature.describe({
    kind: chunkRequestKind(search),
    viewer: viewerOf(user),
    readContext: context ?? "run",
    serverTiming: context === "session",
  });

  const cursor = parseCursor(cursorStartTime, cursorSpanId);
  const showDebug = debug === "1" && (user.admin || user.isImpersonating);
  const presenter = new TraceChunkPresenter();

  if (start) {
    const traceStart = await presenter.start({
      userId: user.id,
      projectSlug: projectParam,
      environmentSlug: envParam,
      runFriendlyId: runParam,
      showDebug,
      isAdmin: user.admin,
      showDeletedLogs: user.isImpersonating,
      selectedSpanId: span,
      emergencySpanCap: env.TRACE_VIEW_EMERGENCY_SPAN_CAP,
      v1RerouteEnabled: env.EVENT_REPOSITORY_V1_REROUTE_ENABLED,
      context,
    });

    if (!traceStart) {
      throw new Response("Trace not found", { status: 404 });
    }

    if (traceStart.kind === "unavailable") {
      requestFeature.recordFallback("chunk", traceStart.reason);
    } else if (traceStart.kind === "logsDeleted") {
      requestFeature.recordFallback("chunk", "logsDeleted");
    }

    return json(traceStart);
  }

  const readAt = Date.now();
  const chunk = await presenter.call({
    userId: user.id,
    projectSlug: projectParam,
    environmentSlug: envParam,
    runFriendlyId: runParam,
    cursor,
    showDebug,
    isAdmin: user.admin,
    showDeletedLogs: user.isImpersonating,
    // Tabs opened before the emergency cap was set; cap their pages too.
    limit: clampToEmergencySpanCap(limit ?? env.EVENTS_CLICKHOUSE_TRACE_CHUNK_SIZE),
    filter,
    tailInsertedAtSinceMs: insertedAtSince,
    context,
  });

  if (!chunk) {
    throw new Response("Trace not found", { status: 404 });
  }

  // Under the emergency cap, open tabs stop background paging after this page instead
  // of paging to their original ceiling in small pages.
  const isBackgroundPage = cursor !== undefined && insertedAtSince === undefined && !filter;
  const stopPaging =
    env.TRACE_VIEW_EMERGENCY_SPAN_CAP !== undefined && isBackgroundPage && chunk.hasMore;

  return json({
    events: chunk.events.map((event) => ({ ...event, startTime: event.startTime.toISOString() })),
    nextCursor: stopPaging ? null : chunk.nextCursor,
    hasMore: stopPaging ? false : chunk.hasMore,
    isTruncated: stopPaging || chunk.isTruncated,
    readAt,
  });
}
