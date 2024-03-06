import { millisecondsToNanoseconds } from "@trigger.dev/core/v3";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView/TreeView";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";
import { eventRepository } from "~/v3/eventRepository.server";

type Result = Awaited<ReturnType<RunPresenter["call"]>>;
export type Run = Result["run"];
export type RunEvent = Result["events"][0];

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
      throw new Error("Trace not found");
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
          return { ...n, data: { ...n.data, offset, isRoot: n.id === traceSummary.rootSpan.id } };
        })
      : [];

    //if any elements are partial we want the total duration to represent all of the time until now
    totalDuration = events.some((e) => e.data.isPartial)
      ? millisecondsToNanoseconds(Date.now() - treeRootStartTimeMs)
      : totalDuration;

    //total duration should be a minimum of 1ms
    totalDuration = Math.max(totalDuration, millisecondsToNanoseconds(1));

    //we need to adjust any partial nodes so they run the full duration
    for (const event of events) {
      if (event.data.isPartial) {
        event.data.duration = totalDuration - event.data.offset;
      }
    }

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
        number: run.number,
        friendlyId: run.friendlyId,
        environment: {
          type: run.runtimeEnvironment.type,
          slug: run.runtimeEnvironment.slug,
          userId: run.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(run.runtimeEnvironment.orgMember?.user),
        },
      },
      rootSpanStatus,
      events: events,
      parentRunFriendlyId:
        tree?.id === traceSummary.rootSpan.id ? undefined : traceSummary.rootSpan.runId,
      duration: totalDuration,
    };
  }
}
