import type { RunStore } from "@internal/run-store";
import { trace } from "@opentelemetry/api";
import type { Prisma } from "@trigger.dev/database";
import { prisma, type PrismaClient } from "~/db.server";
import { stripAdminOnlyEventRows } from "~/utils/timelineSpanEvents";
import type {
  IEventRepository,
  TraceChunk,
  TraceChunkCursor,
} from "~/v3/eventRepository/eventRepository.types";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { getTraceInsertedAtEnd } from "~/v3/eventRepository/traceInsertedAtBound";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import {
  runQueuedDuration,
  runTraceBuildOptions,
  runTraceReadScope,
  runTraceUnavailableBeforeRead,
} from "./runTraceSetup.server";
import { buildFirstTrace, readFirstTraceChunk, type FirstTrace } from "./traceFirstChunk.server";

/** Who is reading. The session view bounds completed runs' reads by write time. */
export type TraceReadContext = "session";

export type RunTraceStart =
  // `empty` only for unfinished runs: no spans yet, still tails.
  | Exclude<FirstTrace, { kind: "fallback" }>
  | {
      kind: "unavailable";
      reason:
        | "legacyStore"
        | "emergencyCap"
        | "chunkUnsupported"
        | "noWriteTimes"
        | "anchorMissing"
        | "noSpans";
    }
  | { kind: "logsDeleted" };

// Every chunk and tail read loads these, so keep them to what scoping the read needs.
const chunkRunSelect = {
  projectId: true,
  createdAt: true,
  taskEventStore: true,
  traceId: true,
  status: true,
  completedAt: true,
  updatedAt: true,
  logsDeletedAt: true,
  runtimeEnvironmentId: true,
} satisfies Prisma.TaskRunSelect;

const startRunSelect = {
  ...chunkRunSelect,
  friendlyId: true,
  spanId: true,
  startedAt: true,
  queueTimestamp: true,
  scheduleId: true,
  annotations: true,
} satisfies Prisma.TaskRunSelect;

type TraceChunkPresenterDeps = {
  prismaClient: PrismaClient;
  runStore: Pick<RunStore, "findRun">;
  resolveEnvironment: typeof controlPlaneResolver.resolveAuthenticatedEnv;
  getRepository: (taskEventStore: string, organizationId: string) => Promise<IEventRepository>;
};

type RunAccess = {
  userId: string;
  projectSlug: string;
  environmentSlug: string;
  runFriendlyId: string;
};

export class TraceChunkPresenter {
  #deps: TraceChunkPresenterDeps;

  constructor(deps: Partial<TraceChunkPresenterDeps> = {}) {
    this.#deps = {
      prismaClient: deps.prismaClient ?? prisma,
      runStore: deps.runStore ?? runStore,
      resolveEnvironment:
        deps.resolveEnvironment ??
        ((environmentId) => controlPlaneResolver.resolveAuthenticatedEnv(environmentId)),
      getRepository: deps.getRepository ?? getEventRepositoryForStore,
    };
  }

  public async call({
    userId,
    projectSlug,
    environmentSlug,
    runFriendlyId,
    cursor,
    showDebug,
    isAdmin,
    showDeletedLogs,
    limit,
    filter,
    tailInsertedAtSinceMs,
    context,
  }: RunAccess & {
    cursor: TraceChunkCursor | undefined;
    showDebug: boolean;
    isAdmin: boolean;
    showDeletedLogs: boolean;
    limit?: number;
    filter?: "errors";
    /** Live tail: only return rows written at/after this write time (ms since epoch). */
    tailInsertedAtSinceMs?: number;
    context?: TraceReadContext;
  }): Promise<(TraceChunk & { isTruncated?: boolean }) | undefined> {
    const run = await this.#deps.runStore.findRun(
      { friendlyId: runFriendlyId },
      { select: chunkRunSelect }
    );
    const environment =
      run && (await this.#authorize(run, { userId, projectSlug, environmentSlug }));

    if (!run || !environment) {
      return undefined;
    }

    if (run.logsDeletedAt && !showDeletedLogs) {
      return { events: [], nextCursor: null, hasMore: false };
    }

    const repository = await this.#deps.getRepository(
      run.taskEventStore,
      environment.organizationId
    );

    const scope = runTraceReadScope(run, environment.id);
    const insertedAtEnd = getTraceInsertedAtEnd(run);
    recordReadAttributes(context, insertedAtEnd);

    if (filter === "errors") {
      const errors = await repository.getTraceErrorEvents(
        scope.storeTable,
        scope.environmentId,
        scope.traceId,
        scope.startCreatedAt,
        scope.endCreatedAt,
        { includeDebugLogs: showDebug, insertedAtEnd }
      );
      if (!errors) {
        return undefined;
      }
      return {
        events: stripAdminOnlyEventRows(errors.events, isAdmin),
        nextCursor: null,
        hasMore: false,
        isTruncated: errors.isTruncated,
      };
    }

    const chunk = await repository.getTraceChunk(
      scope.storeTable,
      scope.environmentId,
      scope.traceId,
      scope.startCreatedAt,
      scope.endCreatedAt,
      cursor,
      { includeDebugLogs: showDebug, limit, tailInsertedAtSinceMs, insertedAtEnd }
    );

    if (!chunk) {
      return undefined;
    }

    return {
      events: stripAdminOnlyEventRows(chunk.events, isAdmin),
      nextCursor: chunk.nextCursor,
      hasMore: chunk.hasMore,
    };
  }

  /** A run's first chunk as a progressive trace payload, without the run page's summary fallback. */
  public async start({
    userId,
    projectSlug,
    environmentSlug,
    runFriendlyId,
    showDebug,
    isAdmin,
    showDeletedLogs,
    selectedSpanId,
    emergencySpanCap,
    v1RerouteEnabled,
    context,
  }: RunAccess & {
    showDebug: boolean;
    isAdmin: boolean;
    showDeletedLogs: boolean;
    selectedSpanId: string | undefined;
    emergencySpanCap: number | undefined;
    v1RerouteEnabled: boolean;
    context?: TraceReadContext;
  }): Promise<RunTraceStart | undefined> {
    const run = await this.#deps.runStore.findRun(
      { friendlyId: runFriendlyId },
      { select: startRunSelect }
    );
    const environment =
      run && (await this.#authorize(run, { userId, projectSlug, environmentSlug }));

    if (!run || !environment) {
      return undefined;
    }

    const unavailable = runTraceUnavailableBeforeRead(run, {
      showDeletedLogs,
      emergencySpanCap,
      v1RerouteEnabled,
    });
    if (unavailable === "logsDeleted") {
      return { kind: "logsDeleted" };
    }
    if (unavailable) {
      return { kind: "unavailable", reason: unavailable };
    }

    const repository = await this.#deps.getRepository(
      run.taskEventStore,
      environment.organizationId
    );

    const scope = runTraceReadScope(run, environment.id);
    const insertedAtEnd = getTraceInsertedAtEnd(run);
    recordReadAttributes(context, insertedAtEnd);

    const firstRead = await readFirstTraceChunk({ repository, scope, showDebug, insertedAtEnd });

    if (!firstRead) {
      return { kind: "unavailable", reason: "chunkUnsupported" };
    }

    const first = await buildFirstTrace({
      repository,
      scope,
      firstRead,
      anchorSpanId: run.spanId,
      selectedSpanId,
      insertedAtEnd,
      buildOptions: runTraceBuildOptions(run, isAdmin),
      startedAt: run.startedAt,
      queuedDuration: runQueuedDuration(run),
      showDebug,
      maxSpans: repository.maximumTraceViewCount,
    });

    if (first.kind === "fallback") {
      return { kind: "unavailable", reason: first.reason };
    }

    // A finished run with no spans won't get any, so there's nothing to tail.
    if (first.kind === "empty" && isFinalRunStatus(run.status)) {
      return { kind: "unavailable", reason: "noSpans" };
    }

    return first;
  }

  // Org membership on the run's project, and the run's environment must be the one in the URL.
  async #authorize(
    run: { projectId: string; runtimeEnvironmentId: string },
    { userId, projectSlug, environmentSlug }: Omit<RunAccess, "runFriendlyId">
  ) {
    const authorizedProject = await this.#deps.prismaClient.project.findFirst({
      where: {
        id: run.projectId,
        slug: projectSlug,
        organization: { members: { some: { userId } } },
      },
      select: { id: true },
    });

    if (!authorizedProject) {
      return undefined;
    }

    const environment = await this.#deps.resolveEnvironment(run.runtimeEnvironmentId);

    if (!environment || environmentSlug !== environment.slug) {
      return undefined;
    }

    return environment;
  }
}

function recordReadAttributes(
  context: TraceReadContext | undefined,
  insertedAtEnd: Date | undefined
) {
  trace.getActiveSpan()?.setAttributes({
    "trace.read_context": context ?? "run",
    "trace.inserted_at_end_applied": insertedAtEnd !== undefined,
  });
}
