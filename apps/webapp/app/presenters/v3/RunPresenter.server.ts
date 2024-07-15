import { millisecondsToNanoseconds } from "@trigger.dev/core/v3/utils/durations";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { type PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";
import { eventRepository } from "~/v3/eventRepository.server";

type Result = Awaited<ReturnType<RunPresenter["call"]>>;
export type Run = Result["run"];
export type RunEvent = NonNullable<Result["trace"]>["events"][0];

export class RunPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    organizationSlug,
    runFriendlyId,
  }: {
    userId: string;
    projectSlug: string;
    organizationSlug: string;
    runFriendlyId: string;
  }) {
    const run = await this.#prismaClient.taskRun.findFirstOrThrow({
      select: {
        id: true,
        number: true,
        traceId: true,
        spanId: true,
        friendlyId: true,
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

    // get the events
    const traceSummary = await eventRepository.getTraceSummary(run.traceId);

    if (!traceSummary) {
      return {
        run: {
          id: run.id,
          number: run.number,
          friendlyId: run.friendlyId,
          traceId: run.traceId,
          environment: {
            id: run.runtimeEnvironment.id,
            organizationId: run.runtimeEnvironment.organizationId,
            type: run.runtimeEnvironment.type,
            slug: run.runtimeEnvironment.slug,
            userId: run.runtimeEnvironment.orgMember?.user.id,
            userName: getUsername(run.runtimeEnvironment.orgMember?.user),
          },
        },
        trace: undefined,
      };
    }

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
          totalDuration = Math.max(totalDuration, offset + n.data.duration);
          return {
            ...n,
            data: {
              ...n.data,
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
      run: {
        id: run.id,
        number: run.number,
        friendlyId: run.friendlyId,
        traceId: run.traceId,
        environment: {
          id: run.runtimeEnvironment.id,
          organizationId: run.runtimeEnvironment.organizationId,
          type: run.runtimeEnvironment.type,
          slug: run.runtimeEnvironment.slug,
          userId: run.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(run.runtimeEnvironment.orgMember?.user),
        },
      },
      trace: {
        rootSpanStatus,
        events: events,
        parentRunFriendlyId:
          tree?.id === traceSummary.rootSpan.id ? undefined : traceSummary.rootSpan.runId,
        duration: totalDuration,
        rootStartedAt: tree?.data.startTime,
      },
    };
  }
}
