import { prisma, type PrismaClient } from "~/db.server";
import { logger } from "~/services/logger.server";
import { getUsername } from "~/utils/username";
import type { SpanSummary } from "~/v3/eventRepository/eventRepository.types";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { env } from "~/env.server";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { canLiveTail } from "./liveTailGate";
import { buildFirstTrace, readFirstTraceChunk } from "./traceFirstChunk.server";
import { runQueuedDuration, runTraceBuildOptions, runTraceReadScope } from "./runTraceSetup.server";
import { buildTraceView } from "~/v3/eventRepository/traceViewBuilder";
import { runStore } from "~/v3/runStore.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runTriggeredAt } from "~/v3/runTimestamps";
import { getRunFinishedAt } from "~/v3/eventRepository/traceInsertedAtBound";

export class RunEnvironmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEnvironmentMismatchError";
  }
}

// Thrown by `call()` when the run isn't in PG. The route loader catches
// this and falls back to the mollifier buffer via `tryMollifiedRunFallback`.
// Using a typed error (rather than Prisma's `findFirstOrThrow` exception)
// keeps the buffered case off the PrismaClient error path — that path
// emits a `PrismaClient error` log every time it fires, which on the
// run-detail page polls becomes per-tick log spam and Sentry noise for
// any run that legitimately lives in the buffer.
export class RunNotInPgError extends Error {
  constructor(public readonly runFriendlyId: string) {
    super(`Run ${runFriendlyId} not in PG`);
    this.name = "RunNotInPgError";
  }
}

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    environmentSlug,
    runFriendlyId,
    showDeletedLogs,
    showDebug,
    selectedSpanId,
  }: {
    userId: string;
    projectSlug: string;
    environmentSlug: string;
    runFriendlyId: string;
    showDeletedLogs: boolean;
    showDebug: boolean;
    selectedSpanId?: string;
  }) {
    // `findFirst` + explicit null check (not `findFirstOrThrow`) because
    // a missing PG row is the *expected* path for buffered runs — the
    // route catches `RunNotInPgError` and falls back to the synthesised
    // buffer view. `findFirstOrThrow` would log a `PrismaClient error`
    // every tick of the page poll, masking real DB issues with synthetic
    // not-found noise.
    //
    // No explicit client arg: the store reads off its own replica and routes by
    // residency once a RoutingRunStore is injected. Pinning this.#prismaClient
    // would override that routing. (The user.findFirst admin check below stays on
    // the control-plane client.)
    // Run-ops read keyed by friendlyId only — routes to the owning DB by residency.
    // The project-scope + membership auth is a control-plane concern resolved
    // separately below; joining project/organization here is a cross-DB join that
    // returns nothing once the run lives in the run-ops DB.
    const run = await runStore.findRun(
      {
        friendlyId: runFriendlyId,
      },
      {
        select: {
          projectId: true,
          id: true,
          createdAt: true,
          taskEventStore: true,
          taskIdentifier: true,
          number: true,
          traceId: true,
          spanId: true,
          parentSpanId: true,
          friendlyId: true,
          status: true,
          startedAt: true,
          queueTimestamp: true,
          scheduleId: true,
          completedAt: true,
          updatedAt: true,
          logsDeletedAt: true,
          annotations: true,
          rootTaskRun: {
            select: {
              friendlyId: true,
              spanId: true,
            },
          },
          parentTaskRun: {
            select: {
              friendlyId: true,
              spanId: true,
            },
          },
          runtimeEnvironmentId: true,
        },
      }
    );

    if (!run) {
      throw new RunNotInPgError(runFriendlyId);
    }

    // Project-scope + membership auth is control-plane only — verify the run's
    // project matches the requested slug and the user is a member, keyed by the
    // run's projectId. A miss is treated as not-found (mirrors the old scoped where).
    const authorizedProject = await this.#prismaClient.project.findFirst({
      where: {
        id: run.projectId,
        slug: projectSlug,
        organization: { members: { some: { userId } } },
      },
      select: { id: true },
    });

    if (!authorizedProject) {
      throw new RunNotInPgError(runFriendlyId);
    }

    const environment = await controlPlaneResolver.resolveAuthenticatedEnv(
      run.runtimeEnvironmentId
    );

    if (!environment) {
      // An unresolvable control-plane env means the run can't be presented from PG;
      // mirror the not-found path the route already handles (mollifier buffer fallback).
      throw new RunNotInPgError(runFriendlyId);
    }

    if (environmentSlug !== environment.slug) {
      throw new RunEnvironmentMismatchError(
        `Run ${runFriendlyId} is not in environment ${environmentSlug}`
      );
    }

    const showLogs = showDeletedLogs || !run.logsDeletedAt;
    const triggeredAt = runTriggeredAt(run);

    const runData = {
      id: run.id,
      number: run.number,
      friendlyId: run.friendlyId,
      taskIdentifier: run.taskIdentifier,
      traceId: run.traceId,
      spanId: run.spanId,
      status: run.status,
      isFinished: isFinalRunStatus(run.status),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      finishedAt: getRunFinishedAt(run) ?? null,
      logsDeletedAt: showDeletedLogs ? null : run.logsDeletedAt,
      rootTaskRun: run.rootTaskRun,
      parentTaskRun: run.parentTaskRun,
      environment: {
        id: environment.id,
        organizationId: environment.organizationId,
        type: environment.type,
        slug: environment.slug,
        userId: environment.orgMember?.user?.id,
        userName: getUsername(environment.orgMember?.user),
      },
    };

    if (!showLogs) {
      return {
        run: runData,
        trace: undefined,
        maximumLiveReloadingSetting: env.MAXIMUM_LIVE_RELOADING_EVENTS,
      };
    }

    const repository = await getEventRepositoryForStore(
      run.taskEventStore,
      environment.organizationId
    );

    const traceScope = runTraceReadScope(run, environment.id);
    const queuedDuration = runQueuedDuration(run);

    const firstChunkPromise = canLiveTail(
      run.taskEventStore,
      env.TRACE_VIEW_EMERGENCY_SPAN_CAP,
      env.EVENT_REPOSITORY_V1_REROUTE_ENABLED
    )
      ? readFirstTraceChunk({ repository, scope: traceScope, showDebug })
      : Promise.resolve(undefined);

    const [user, firstRead] = await Promise.all([
      this.#prismaClient.user.findFirst({
        where: { id: userId },
        select: { admin: true },
      }),
      firstChunkPromise,
    ]);

    const buildOptions = runTraceBuildOptions(run, user?.admin ?? false);

    const first = firstRead
      ? await buildFirstTrace({
          repository,
          scope: traceScope,
          firstRead,
          anchorSpanId: run.spanId,
          selectedSpanId,
          buildOptions,
          startedAt: run.startedAt,
          queuedDuration,
          showDebug,
          maxSpans: repository.maximumTraceViewCount,
        })
      : undefined;

    if (first?.kind === "progressive") {
      return {
        run: runData,
        trace: first.trace,
        maximumLiveReloadingSetting: repository.maximumLiveReloadingSetting,
      };
    }

    // An empty first chunk, or an anchor the span-id lookup didn't find, means the
    // summary and subtree reads would search the same window for nothing.
    const anchorMissing = first?.kind === "fallback" && first.reason === "anchorMissing";
    const skipSummary = first?.kind === "empty" || anchorMissing;

    if (anchorMissing) {
      logger.warn("Trace first chunk missing anchor span", {
        runId: run.friendlyId,
        spanId: run.spanId,
        traceId: run.traceId,
      });
    }

    // Fast path: summary rooted at the viewed run. Slow path: subtree fetch when the
    // anchor fell past the row cap (large traces ordered by start_time ASC).
    let traceSummary = skipSummary
      ? undefined
      : await repository.getTraceSummary(
          traceScope.storeTable,
          environment.id,
          run.traceId,
          traceScope.startCreatedAt,
          traceScope.endCreatedAt,
          { includeDebugLogs: showDebug, anchorSpanId: run.spanId }
        );

    let isTruncated = traceSummary?.isTruncated ?? false;

    if (!traceSummary && !skipSummary) {
      const subtreeSummary = await repository.getTraceSubtreeSummary(
        traceScope.storeTable,
        environment.id,
        run.traceId,
        run.spanId,
        traceScope.startCreatedAt,
        traceScope.endCreatedAt,
        // The anchor is the viewed run: a root has no ancestors, a child doesn't need them.
        { includeDebugLogs: showDebug }
      );

      if (subtreeSummary) {
        // Only an anchor past the row cap lands here; an empty trace finds nothing.
        logger.warn("Trace summary missing anchor span, used subtree fetch", {
          runId: run.friendlyId,
          spanId: run.spanId,
          traceId: run.traceId,
        });
        traceSummary = subtreeSummary;
        isTruncated = subtreeSummary.isTruncated ?? false;
      }
    }

    if (!traceSummary) {
      const spanSummary: SpanSummary = {
        id: run.spanId,
        parentId: run.parentSpanId ?? undefined,
        runId: run.friendlyId,
        data: {
          message: run.taskIdentifier,
          style: { icon: "task", variant: "primary" },
          events: [],
          startTime: triggeredAt,
          duration: 0,
          isError:
            run.status === "COMPLETED_WITH_ERRORS" ||
            run.status === "CRASHED" ||
            run.status === "EXPIRED" ||
            run.status === "SYSTEM_FAILURE" ||
            run.status === "TIMED_OUT",
          isPartial:
            run.status === "DELAYED" ||
            run.status === "PENDING" ||
            run.status === "PAUSED" ||
            run.status === "RETRYING_AFTER_FAILURE" ||
            run.status === "DEQUEUED" ||
            run.status === "EXECUTING" ||
            run.status === "WAITING_TO_RESUME",
          isCancelled: run.status === "CANCELED",
          isDebug: false,
          level: "TRACE",
        },
      };

      traceSummary = {
        rootSpan: spanSummary,
        spans: [spanSummary],
      };
    }

    const view = buildTraceView(traceSummary.spans, {
      ...buildOptions,
      isRootSpanId: traceSummary.rootSpan.id,
    });
    const missingAnchor = view.missingAnchor;

    if (missingAnchor) {
      logger.warn("Trace view anchor span not found in trace summary", {
        runId: run.friendlyId,
        spanId: run.spanId,
        traceId: run.traceId,
        spanCount: traceSummary.spans.length,
      });

      isTruncated = true;
    }

    return {
      run: runData,
      trace: {
        rootSpanStatus: view.rootSpanStatus,
        events: view.events,
        duration: view.duration,
        rootStartedAt: view.rootStartedAt,
        startedAt: run.startedAt,
        queuedDuration,
        overridesBySpanId: traceSummary.overridesBySpanId,
        linkedRunIdBySpanId: view.linkedRunIdBySpanId,
        isTruncated,
        missingAnchor,
        progressive: undefined,
      },
      maximumLiveReloadingSetting: repository.maximumLiveReloadingSetting,
    };
  }
}
