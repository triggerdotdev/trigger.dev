import { type SpanEvents } from "@trigger.dev/core/v3";
import { type TaskEventStyle } from "@trigger.dev/core/v3/schemas";
import { nanosecondsToMilliseconds } from "@trigger.dev/core/v3/utils/durations";
import { boundedIn, type PrismaReplicaClient } from "@trigger.dev/database";
import { $replica } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getAdminOnlyForEvent } from "~/utils/timelineSpanEvents";
import { type SpanSummary, type TraceSummary } from "~/v3/eventRepository/eventRepository.types";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { runStore } from "~/v3/runStore.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";

type DashboardAgentTraceSpan = {
  id: string;
  parentId: string | undefined;
  runId: string;
  data: {
    message: string;
    taskSlug?: string;
    style: TaskEventStyle;
    events: SpanEvents;
    startTime: Date;
    durationMs?: number;
    isError: boolean;
    isPartial: boolean;
    isCancelled: boolean;
    level: SpanSummary["data"]["level"];
    attemptNumber?: number;
  };
  children: Array<DashboardAgentTraceSpan>;
};

export type DashboardAgentTrace = {
  traceId: string;
  rootSpan: DashboardAgentTraceSpan;
  isTruncated?: boolean;
};

// Measured: JSON.stringify on this nested `children` shape throws RangeError at 4,001 levels
// (Node 20 and 24, default stack); 1,500 keeps a 2x margin under that ceiling.
const MAX_TREE_DEPTH = 1_500;

type TraceRun = {
  friendlyId: string;
  traceId: string;
  spanId: string;
  createdAt: Date;
  completedAt: Date | null;
  taskEventStore: string;
};

export async function getDashboardAgentRunTrace({
  run,
  environmentId,
  organizationId,
  prisma = $replica,
}: {
  run: TraceRun;
  environmentId: string;
  organizationId: string;
  prisma?: PrismaReplicaClient;
}): Promise<{ trace: DashboardAgentTrace } | undefined> {
  const repository = await getEventRepositoryForStore(run.taskEventStore, organizationId);
  const storeTable = getTaskEventStoreTableForRun(run);
  const endCreatedAt = run.completedAt ?? undefined;

  let summary: TraceSummary | undefined = await repository.getTraceSummary(
    storeTable,
    environmentId,
    run.traceId,
    run.createdAt,
    endCreatedAt,
    { includeDebugLogs: false }
  );

  // The anchor span can fall past the row cap on large traces, so fall back to
  // the subtree fetch like the run page does.
  if (summary && !summary.spans.some((span) => span.id === run.spanId)) {
    const subtree = await repository.getTraceSubtreeSummary(
      storeTable,
      environmentId,
      run.traceId,
      run.spanId,
      run.createdAt,
      endCreatedAt,
      { includeDebugLogs: false }
    );

    if (subtree) {
      summary = subtree;
    }
  }

  if (!summary) {
    return;
  }

  const runIds = new Set<string>();
  const built = buildTree(summary.spans, run.spanId, runIds);

  if (!built) {
    logger.warn("Dashboard agent trace anchor span not found in trace summary", {
      runId: run.friendlyId,
      spanId: run.spanId,
      traceId: run.traceId,
      spanCount: summary.spans.length,
    });

    return;
  }

  const { rootSpan, isTruncated: depthTruncated } = built;
  const isTruncated = (summary.isTruncated ?? false) || depthTruncated;

  applyTaskSlugs(rootSpan, await taskSlugsByRunId(prisma, runIds, environmentId));

  return {
    trace: {
      traceId: run.traceId,
      rootSpan,
      ...(isTruncated ? { isTruncated: true } : {}),
    },
  };
}

async function taskSlugsByRunId(
  prisma: PrismaReplicaClient,
  runIds: Set<string>,
  environmentId: string
): Promise<Map<string, string>> {
  if (runIds.size === 0) {
    return new Map();
  }

  const runs = await runStore.findRuns(
    {
      where: {
        friendlyId: { in: boundedIn(Array.from(runIds)) },
        runtimeEnvironmentId: environmentId,
      },
      select: { friendlyId: true, taskIdentifier: true },
    },
    prisma
  );

  return new Map(runs.map((run) => [run.friendlyId, run.taskIdentifier]));
}

function applyTaskSlugs(rootSpan: DashboardAgentTraceSpan, taskSlugs: Map<string, string>) {
  const stack = [rootSpan];

  while (stack.length > 0) {
    const span = stack.pop()!;
    const taskSlug = span.runId ? taskSlugs.get(span.runId) : undefined;

    if (taskSlug) {
      span.data.taskSlug = taskSlug;
    }

    for (const child of span.children) {
      stack.push(child);
    }
  }
}

function buildTree(
  spans: Array<SpanSummary>,
  rootSpanId: string,
  runIds: Set<string>
): { rootSpan: DashboardAgentTraceSpan; isTruncated: boolean } | undefined {
  const spanById = new Map<string, SpanSummary>();
  const childrenByParentId = new Map<string, Array<SpanSummary>>();

  for (const span of spans) {
    spanById.set(span.id, span);

    if (!span.parentId || span.id === rootSpanId) {
      continue;
    }

    const siblings = childrenByParentId.get(span.parentId);
    if (siblings) {
      siblings.push(span);
    } else {
      childrenByParentId.set(span.parentId, [span]);
    }
  }

  const root = spanById.get(rootSpanId);

  if (!root) {
    return;
  }

  // Walk the reachable spans breadth-first, capping how deep we descend, before building any
  // tree nodes. This keeps both passes as plain loops instead of one recursion per nesting level.
  const included = new Set<string>([rootSpanId]);
  let isTruncated = false;
  let frontier = [rootSpanId];
  let depth = 0;

  while (frontier.length > 0) {
    if (depth >= MAX_TREE_DEPTH) {
      // Frontier nodes at the cap are already included; only truncate if any of them
      // actually has further children we're choosing not to include.
      isTruncated = frontier.some((id) =>
        (childrenByParentId.get(id) ?? []).some((child) => !included.has(child.id))
      );
      break;
    }

    const nextFrontier: Array<string> = [];

    for (const id of frontier) {
      for (const child of childrenByParentId.get(id) ?? []) {
        if (included.has(child.id)) {
          continue;
        }

        included.add(child.id);
        nextFrontier.push(child.id);
      }
    }

    frontier = nextFrontier;
    depth++;
  }

  const nodeById = new Map<string, DashboardAgentTraceSpan>();

  for (const id of included) {
    const span = spanById.get(id)!;

    if (span.runId) {
      runIds.add(span.runId);
    }

    nodeById.set(id, toTraceSpan(span, []));
  }

  for (const id of included) {
    const node = nodeById.get(id)!;

    node.children = (childrenByParentId.get(id) ?? [])
      .filter((child) => included.has(child.id))
      .sort((a, b) => a.data.startTime.getTime() - b.data.startTime.getTime())
      .map((child) => nodeById.get(child.id)!);
  }

  return { rootSpan: nodeById.get(rootSpanId)!, isTruncated };
}

function customerVisibleEvents(events: SpanEvents): SpanEvents {
  if (!events) {
    return [];
  }

  return events.filter((event) => {
    // Only the internal "trigger.dev/" events are admin-gated; the rest (exception,
    // attempt_failed, cancellation) are what the run page shows everyone.
    if (!event.name.startsWith("trigger.dev/")) {
      return true;
    }

    // Properties are undefined when the stored event carried none.
    const eventName =
      event.properties && "event" in event.properties && typeof event.properties.event === "string"
        ? event.properties.event
        : event.name;

    return !getAdminOnlyForEvent(eventName);
  });
}

function toTraceSpan(
  span: SpanSummary,
  children: Array<DashboardAgentTraceSpan>
): DashboardAgentTraceSpan {
  const { data } = span;

  return {
    id: span.id,
    parentId: span.parentId,
    runId: span.runId,
    data: {
      message: data.message,
      style: data.style,
      events: customerVisibleEvents(data.events),
      startTime: data.startTime,
      ...(data.isPartial
        ? {}
        : { durationMs: Math.round(nanosecondsToMilliseconds(data.duration)) }),
      isError: data.isError,
      isPartial: data.isPartial,
      isCancelled: data.isCancelled,
      level: data.level,
      ...(data.attemptNumber === undefined ? {} : { attemptNumber: data.attemptNumber }),
    },
    children,
  };
}
