// Import from the narrow subpaths only — never the `@trigger.dev/core/v3` root
// barrel. That barrel re-exports dozens of `*-api.js` global-singleton modules
// and pulling it into the webapp's running task worker re-initializes those
// globals. `/v3/errors` and `/v3/schemas` are pure zod/data with no side effects.
import { createJsonErrorObject } from "@trigger.dev/core/v3/errors";
import {
  isAttemptFailedSpanEvent,
  isCancellationSpanEvent,
  isExceptionSpanEvent,
  TaskRunError,
  type SpanEvents,
} from "@trigger.dev/core/v3/schemas";
import type { SpanDetailSummary, SpanException, ToolContext } from "../types";

const MAX_FIELD_LENGTH = 2000;
const MAX_STACK_LENGTH = 4000;
const MAX_EXCEPTIONS = 5;

const FAILED_RUN_STATUSES = new Set([
  "COMPLETED_WITH_ERRORS",
  "CRASHED",
  "SYSTEM_FAILURE",
  "TIMED_OUT",
  "EXPIRED",
]);

function truncate(value: string | undefined, max: number): string | undefined {
  if (value === undefined) return undefined;
  return value.length <= max ? value : value.slice(0, max) + "\n…(truncated)";
}

function stringifyField(value: unknown): string | undefined {
  if (value === undefined || value === null) return undefined;
  const s = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return truncate(s, MAX_FIELD_LENGTH);
}

// Pull every exception/cancellation out of a span's OTel events.
function extractExceptions(events: SpanEvents | undefined): SpanException[] {
  if (!events?.length) return [];
  const out: SpanException[] = [];
  for (const event of events) {
    if (isExceptionSpanEvent(event) || isAttemptFailedSpanEvent(event)) {
      const ex = event.properties.exception;
      out.push({
        type: ex.type,
        message: ex.message,
        stackTrace: truncate(ex.stacktrace, MAX_STACK_LENGTH),
      });
    } else if (isCancellationSpanEvent(event)) {
      out.push({ type: "cancellation", message: event.properties.reason });
    }
    if (out.length >= MAX_EXCEPTIONS) break;
  }
  return out;
}

function exceptionFromRunError(error: unknown): SpanException | undefined {
  const parsed = TaskRunError.safeParse(error);
  if (parsed.success) {
    const json = createJsonErrorObject(parsed.data);
    return {
      type: json.name,
      message: json.message,
      stackTrace: truncate(json.stackTrace, MAX_STACK_LENGTH),
    };
  }
  return { message: truncate(JSON.stringify(error), MAX_STACK_LENGTH) };
}

function formatDuration(nanos: number | null | undefined): string | undefined {
  if (nanos === null || nanos === undefined) return undefined;
  return `${Math.round(nanos / 1_000_000)}ms`;
}

export async function getSpanForLLM(
  ctx: ToolContext,
  runFriendlyId: string,
  spanId: string
): Promise<SpanDetailSummary | { error: string } | null> {
  try {
    // Use the dedicated trigger-task Prisma client and the engine-free event
    // repository. We deliberately do NOT touch SpanPresenter here: it imports
    // `~/v3/runEngine.server`, whose `engine.resolveTaskRunContext()` boots the
    // full RunEngine singleton (Redis, background workers, heartbeats) inside the
    // task worker and floods the OTel ingest endpoint. The event repository's
    // `getSpan` returns the same span detail without any of that.
    const { prisma } = await import("../../db");
    const { getEventRepositoryForStore } = await import("~/v3/eventRepository/index.server");
    const { getTaskEventStoreTableForRun } = await import("~/v3/taskEventStore.server");

    const parentRun = await prisma.taskRun.findFirst({
      where: {
        friendlyId: runFriendlyId,
        runtimeEnvironment: {
          slug: ctx.clientData.environmentSlug,
          project: { slug: ctx.clientData.projectSlug },
        },
      },
      select: {
        traceId: true,
        taskEventStore: true,
        createdAt: true,
        completedAt: true,
        runtimeEnvironmentId: true,
        runtimeEnvironment: { select: { organizationId: true } },
      },
    });

    if (!parentRun) {
      return { error: `Run ${runFriendlyId} not found` };
    }

    const repository = await getEventRepositoryForStore(
      parentRun.taskEventStore,
      parentRun.runtimeEnvironment.organizationId
    );
    const eventStore = getTaskEventStoreTableForRun(parentRun);

    const span = await repository.getSpan(
      eventStore,
      parentRun.runtimeEnvironmentId,
      spanId,
      parentRun.traceId,
      parentRun.createdAt,
      parentRun.completedAt ?? undefined,
      { includeDebugLogs: true }
    );

    // If this span is itself a triggered run, surface that run's error/output
    // straight from the TaskRun row (no presenter, no engine).
    const spanRun = await prisma.taskRun.findFirst({
      where: { spanId, runtimeEnvironmentId: parentRun.runtimeEnvironmentId },
      select: {
        friendlyId: true,
        status: true,
        taskIdentifier: true,
        error: true,
        output: true,
        outputType: true,
        metadata: true,
      },
    });

    if (!span && !spanRun) {
      return { error: `Span ${spanId} not found in run ${runFriendlyId}` };
    }

    const exceptions = extractExceptions(span?.events as SpanEvents | undefined);
    if (spanRun?.error) {
      const runException = exceptionFromRunError(spanRun.error);
      if (runException) exceptions.unshift(runException);
    }

    const properties = stringifyField(span?.properties);

    if (spanRun) {
      // Packet references (application/store) are download keys, not data.
      const output =
        spanRun.output && spanRun.outputType !== "application/store"
          ? stringifyField(spanRun.output)
          : undefined;

      return {
        spanId,
        kind: "run",
        message: span?.message ?? spanRun.taskIdentifier,
        isError: span?.isError ?? FAILED_RUN_STATUSES.has(spanRun.status),
        isCancelled: span?.isCancelled ?? spanRun.status === "CANCELED",
        level: span?.level,
        duration: formatDuration(span?.duration),
        runFriendlyId: spanRun.friendlyId,
        taskIdentifier: spanRun.taskIdentifier,
        status: spanRun.status,
        exceptions,
        metadata: stringifyField(spanRun.metadata),
        properties,
        output,
      };
    }

    // A generic trace span (HTTP call, log group, tool call, etc.).
    return {
      spanId: span!.spanId,
      kind: "span",
      message: span!.message,
      isError: span!.isError,
      isCancelled: span!.isCancelled,
      level: span!.level,
      duration: formatDuration(span!.duration),
      exceptions,
      properties,
    };
  } catch (error) {
    return {
      error: `Failed to get span details: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }
}
