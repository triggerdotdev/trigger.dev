import { StyleSchema } from "@trigger.dev/core";
import { TaskEventStyle } from "@trigger.dev/core/v3";
import { TaskEvent } from "@trigger.dev/database";
import { createTreeFromFlatItems, flattenTree } from "~/components/primitives/TreeView";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";

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
    const events = await this.#prismaClient.$queryRaw<(TaskEvent & { rank: BigInt })[]>`
    WITH ranked_events AS (
        SELECT *,
        ROW_NUMBER() OVER (PARTITION BY "spanId" ORDER BY "isPartial" ASC) as rank
        FROM "TaskEvent"
        WHERE "traceId" = ${run.traceId}
    )
    SELECT *
    FROM ranked_events
    WHERE rank = 1
    ORDER BY "startTime" ASC;
    `;

    const tree = createTreeFromFlatItems(
      events.map((event) => {
        return {
          id: event.spanId,
          parentId: event.parentId ?? undefined,
          data: {
            message: event.message,
            style: TaskEventStyle.parse(event.style),
            duration: Number(event.duration),
            isError: event.isError,
            isPartial: event.isPartial,
            startTime: event.startTime,
            level: event.level,
          },
        };
      }),
      run.spanId
    );

    const rootSpanId = events.find((event) => !event.parentId);
    if (!rootSpanId) {
      throw new Error("Root span not found");
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
      events: tree ? flattenTree(tree) : [],
      parentRunFriendlyId: tree?.id === rootSpanId.spanId ? undefined : rootSpanId.runId,
    };
  }
}
