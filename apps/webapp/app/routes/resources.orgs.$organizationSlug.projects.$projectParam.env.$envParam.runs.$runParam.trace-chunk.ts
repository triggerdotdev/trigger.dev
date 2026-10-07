import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { env } from "~/env.server";
import { TraceChunkPresenter } from "~/presenters/v3/TraceChunkPresenter.server";
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

export async function loader({ request, params }: LoaderFunctionArgs) {
  const user = await requireUser(request);
  const { projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);

  const url = new URL(request.url);
  const { cursorStartTime, cursorSpanId, debug, limit, filter, insertedAtSince } =
    SearchSchema.parse(Object.fromEntries(url.searchParams));

  const cursor = parseCursor(cursorStartTime, cursorSpanId);
  const readAt = Date.now();
  const presenter = new TraceChunkPresenter();
  const chunk = await presenter.call({
    userId: user.id,
    projectSlug: projectParam,
    environmentSlug: envParam,
    runFriendlyId: runParam,
    cursor,
    showDebug: debug === "1" && (user.admin || user.isImpersonating),
    isAdmin: user.admin,
    showDeletedLogs: user.isImpersonating,
    // Tabs opened before the emergency cap was set; cap their pages too.
    limit: clampToEmergencySpanCap(limit ?? env.EVENTS_CLICKHOUSE_TRACE_CHUNK_SIZE),
    filter,
    tailInsertedAtSinceMs: insertedAtSince,
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
