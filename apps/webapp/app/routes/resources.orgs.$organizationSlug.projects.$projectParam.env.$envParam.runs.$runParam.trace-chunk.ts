import { json, type LoaderFunctionArgs } from "@remix-run/server-runtime";
import { z } from "zod";
import { TraceChunkPresenter } from "~/presenters/v3/TraceChunkPresenter.server";
import { getImpersonationState } from "~/services/impersonation.server";
import { requireUser } from "~/services/session.server";
import { v3RunParamsSchema } from "~/utils/pathBuilder";
import type { TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";

const SearchSchema = z.object({
  cursorStartTime: z.string().optional().catch(undefined),
  cursorSpanId: z.string().optional().catch(undefined),
  debug: z.literal("1").optional().catch(undefined),
  limit: z.coerce.number().int().positive().max(10_000).optional().catch(undefined),
  filter: z.literal("errors").optional().catch(undefined),
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
  const { isImpersonating } = await getImpersonationState(request, user.id);
  const { projectParam, envParam, runParam } = v3RunParamsSchema.parse(params);

  const url = new URL(request.url);
  const { cursorStartTime, cursorSpanId, debug, limit, filter } = SearchSchema.parse(
    Object.fromEntries(url.searchParams)
  );

  const presenter = new TraceChunkPresenter();
  const chunk = await presenter.call({
    userId: user.id,
    projectSlug: projectParam,
    environmentSlug: envParam,
    runFriendlyId: runParam,
    cursor: parseCursor(cursorStartTime, cursorSpanId),
    showDebug: debug === "1" && user.admin,
    isAdmin: user.admin,
    showDeletedLogs: isImpersonating,
    limit,
    filter,
  });

  if (!chunk) {
    throw new Response("Trace not found", { status: 404 });
  }

  return json({
    events: chunk.events.map((event) => ({ ...event, startTime: event.startTime.toISOString() })),
    nextCursor: chunk.nextCursor,
    hasMore: chunk.hasMore,
  });
}
