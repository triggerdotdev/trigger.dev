import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { prisma, type PrismaClient } from "~/db.server";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import { getUsername } from "~/utils/username";
import { resolveEventRepositoryForStore } from "~/v3/eventRepository/index.server";
import { SpanSummary } from "~/v3/eventRepository/eventRepository.types";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { isFinalRunStatus } from "~/v3/taskStatus";
import { env } from "~/env.server";

type Result = Awaited<ReturnType<RunPresenter["call"]>>;
export type Run = Result["run"];
export type RunEvent = NonNullable<Result["trace"]>["events"][0];

export class RunEnvironmentMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RunEnvironmentMismatchError";
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
  }: {
    userId: string;
    projectSlug: string;
    environmentSlug: string;
    runFriendlyId: string;
    showDeletedLogs: boolean;
    showDebug: boolean;
  }) {
    const run = await this.#prismaClient.taskRun.findFirstOrThrow({
      select: {
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
        completedAt: true,
        logsDeletedAt: true,
        rootTaskRun: {
          select: {
            friendlyId: true,
            spanId: true,
            createdAt: true,
          },
        },
        parentTaskRun: {
          select: {
            friendlyId: true,
            spanId: true,
            createdAt: true,
          },
        },
        runtimeEnvironment: {
          select: {
            id: true,
            type: true,
            slug: true,
            organizationId: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        friendlyId: runFriendlyId,
        project: {
          slug: projectSlug,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    if (environmentSlug !== run.runtimeEnvironment.slug) {
      throw new RunEnvironmentMismatchError(
        `Run ${runFriendlyId} is not in environment ${environmentSlug}`
      );
    }

    const showLogs = showDeletedLogs || !run.logsDeletedAt;

    const runData = {
      id: run.id,
      number: run.number,
      friendlyId: run.friendlyId,
      traceId: run.traceId,
      spanId: run.spanId,
      status: run.status,
      isFinished: isFinalRunStatus(run.status),
      startedAt: run.startedAt,
      completedAt: run.completedAt,
      logsDeletedAt: showDeletedLogs ? null : run.logsDeletedAt,
      rootTaskRun: run.rootTaskRun,
      parentTaskRun: run.parentTaskRun,
      environment: {
        id: run.runtimeEnvironment.id,
        organizationId: run.runtimeEnvironment.organizationId,
        type: run.runtimeEnvironment.type,
        slug: run.runtimeEnvironment.slug,
        userId: run.runtimeEnvironment.orgMember?.user.id,
        userName: getUsername(run.runtimeEnvironment.orgMember?.user),
      },
    };

    if (!showLogs) {
      return {
        run: runData,
        trace: undefined,
        maximumLiveReloadingSetting: env.MAXIMUM_LIVE_RELOADING_EVENTS,
      };
    }

    const eventRepository = resolveEventRepositoryForStore(run.taskEventStore);

    // get the events
    let traceSummary = await eventRepository.getTraceSummary(
      getTaskEventStoreTableForRun(run),
      run.runtimeEnvironment.id,
      run.traceId,
      run.rootTaskRun?.createdAt ?? run.createdAt,
      run.completedAt ?? undefined,
      { includeDebugLogs: showDebug }
    );

    if (!traceSummary) {
      const spanSummary: SpanSummary = {
        id: run.spanId,
        parentId: run.parentSpanId ?? undefined,
        runId: run.friendlyId,
        data: {
          message: run.taskIdentifier,
          style: { icon: "task", variant: "primary" },
          events: [],
          startTime: run.createdAt,
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

    const user = await this.#prismaClient.user.findFirst({
      where: {
        id: userId,
      },
      select: {
        admin: true,
      },
    });

    //this tree starts at the passed in span (hides parent elements if there are any)
    const tree = createTreeFromFlatItems(traceSummary.spans, run.spanId);

    //we need the start offset for each item, and the total duration of the entire tree
    const treeRootStartTimeMs = tree ? tree?.data.startTime.getTime() : 0;
    let totalDuration = tree?.data.duration ?? 0;

    // Build the linkedRunIdBySpanId map during the same walk
    const linkedRunIdBySpanId: Record<string, string> = {};

    const events = tree
      ? flattenTree(tree).map((n) => {
          const offset = millisecondsToNanoseconds(
            n.data.startTime.getTime() - treeRootStartTimeMs
          );
          //only let non-debug events extend the total duration
          if (!n.data.isDebug) {
            totalDuration = Math.max(totalDuration, offset + n.data.duration);
          }

          // For cached spans, store the mapping from spanId to the linked run's ID
          if (n.data.style?.icon === "task-cached" && n.runId) {
            linkedRunIdBySpanId[n.id] = n.runId;
          }

          return {
            ...n,
            data: {
              ...n.data,
              timelineEvents: createTimelineSpanEventsFromSpanEvents(
                n.data.events,
                user?.admin ?? false,
                treeRootStartTimeMs
              ),
              //set partial nodes to null duration
              duration: n.data.isPartial ? null : n.data.duration,
              offset,
              isRoot: n.id === traceSummary.rootSpan.id,
            },
          };
        })
      : [];

    //total duration should be a minimum of 1ms
    totalDuration = Math.max(totalDuration, millisecondsToNanoseconds(1));

    let rootSpanStatus: "executing" | "completed" | "failed" = "executing";
    if (events[0]) {
      if (events[0].data.isError) {
        rootSpanStatus = "failed";
      } else if (!events[0].data.isPartial) {
        rootSpanStatus = "completed";
      }
    }

    return {
      run: runData,
      trace: {
        rootSpanStatus,
        events: events,
        duration: totalDuration,
        rootStartedAt: tree?.data.startTime,
        startedAt: run.startedAt,
        queuedDuration: run.startedAt
          ? millisecondsToNanoseconds(run.startedAt.getTime() - run.createdAt.getTime())
          : undefined,
        overridesBySpanId: traceSummary.overridesBySpanId,
        linkedRunIdBySpanId,
      },
      maximumLiveReloadingSetting: eventRepository.maximumLiveReloadingSetting,
    };
  }
}
