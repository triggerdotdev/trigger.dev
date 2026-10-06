import { prisma, type PrismaClient } from "~/db.server";
import { stripAdminOnlyEventRows } from "~/utils/timelineSpanEvents";
import type { TraceChunk, TraceChunkCursor } from "~/v3/eventRepository/eventRepository.types";
import { getEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { controlPlaneResolver } from "~/v3/runOpsMigration/controlPlaneResolver.server";
import { runStore } from "~/v3/runStore.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";

export class TraceChunkPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
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
  }: {
    userId: string;
    projectSlug: string;
    environmentSlug: string;
    runFriendlyId: string;
    cursor: TraceChunkCursor | undefined;
    showDebug: boolean;
    isAdmin: boolean;
    showDeletedLogs: boolean;
    limit?: number;
    filter?: "errors";
  }): Promise<TraceChunk | undefined> {
    const run = await runStore.findRun(
      { friendlyId: runFriendlyId },
      {
        select: {
          projectId: true,
          createdAt: true,
          taskEventStore: true,
          traceId: true,
          completedAt: true,
          logsDeletedAt: true,
          runtimeEnvironmentId: true,
          rootTaskRun: {
            select: {
              createdAt: true,
            },
          },
        },
      }
    );

    if (!run) {
      return undefined;
    }

    const authorizedProject = await this.#prismaClient.project.findFirst({
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

    const environment = await controlPlaneResolver.resolveAuthenticatedEnv(
      run.runtimeEnvironmentId
    );

    if (!environment || environmentSlug !== environment.slug) {
      return undefined;
    }

    if (run.logsDeletedAt && !showDeletedLogs) {
      return { events: [], nextCursor: null, hasMore: false };
    }

    const repository = await getEventRepositoryForStore(
      run.taskEventStore,
      environment.organizationId
    );

    const storeTable = getTaskEventStoreTableForRun(run);
    const startCreatedAt = run.rootTaskRun?.createdAt ?? run.createdAt;
    const endCreatedAt = run.completedAt ?? undefined;

    if (filter === "errors") {
      const events = await repository.getTraceErrorEvents(
        storeTable,
        environment.id,
        run.traceId,
        startCreatedAt,
        endCreatedAt,
        { includeDebugLogs: showDebug }
      );
      if (!events) {
        return undefined;
      }
      return {
        events: stripAdminOnlyEventRows(events, isAdmin),
        nextCursor: null,
        hasMore: false,
      };
    }

    const chunk = await repository.getTraceChunk(
      storeTable,
      environment.id,
      run.traceId,
      startCreatedAt,
      endCreatedAt,
      cursor,
      { includeDebugLogs: showDebug, limit }
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
}
