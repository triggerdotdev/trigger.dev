import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { prisma, PrismaClient } from "~/db.server";
import { createTimelineSpanEventsFromSpanEvents } from "~/utils/timelineSpanEvents";
import { getUsername } from "~/utils/username";
import { eventRepository } from "~/v3/eventRepository.server";
import { getTaskEventStoreTableForRun } from "~/v3/taskEventStore.server";
import { isFinalRunStatus } from "~/v3/taskStatus";

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
    organizationSlug,
    environmentSlug,
    runFriendlyId,
    showDeletedLogs,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    environmentSlug: string;
    runFriendlyId: string;
    showDeletedLogs: boolean;
  }) {
    const run = await this.#prismaClient.taskRun.findFirstOrThrow({
      select: {
        id: true,
        createdAt: true,
        taskEventStore: true,
        number: true,
        traceId: true,
        spanId: true,
        friendlyId: true,
        status: true,
        startedAt: true,
        completedAt: true,
        logsDeletedAt: true,
        rootTaskRun: {
          select: {
            friendlyId: true,
            taskIdentifier: true,
            spanId: true,
            createdAt: true,
          },
        },
        parentTaskRun: {
          select: {
            friendlyId: true,
            taskIdentifier: true,
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
      };
    }

    // get the events
    const traceSummary = await eventRepository.getTraceSummary(
      getTaskEventStoreTableForRun(run),
      run.traceId,
      run.rootTaskRun?.createdAt ?? run.createdAt,
      run.completedAt ?? undefined
    );
    if (!traceSummary) {
      return {
        run: runData,
        trace: undefined,
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
    const events = tree
      ? flattenTree(tree).map((n) => {
          const offset = millisecondsToNanoseconds(
            n.data.startTime.getTime() - treeRootStartTimeMs
          );
          //only let non-debug events extend the total duration
          if (!n.data.isDebug) {
            totalDuration = Math.max(totalDuration, offset + n.data.duration);
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
      },
    };
  }
}
