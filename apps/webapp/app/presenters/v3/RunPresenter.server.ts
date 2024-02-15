import { Prisma, TaskEvent, TaskRunAttemptStatus } from "@trigger.dev/database";
import { number } from "zod";
import {
  FlatTreeItem,
  createFlatTreeFromWithoutChildren,
  createTreeFromFlatItems,
  flattenTree,
} from "~/components/primitives/TreeView";
import { Direction } from "~/components/runs/RunStatuses";
import { ExtendedTaskAttemptStatus } from "~/components/runs/v3/RunFilters";
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
    // Find the project scoped to the organization
    const run = await this.#prismaClient.taskRun.findFirstOrThrow({
      select: {
        id: true,
        number: true,
        traceId: true,
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
            duration: Number(event.duration),
          },
        };
      })
    );

    return {
      run: {
        number: run.number,
        environment: {
          type: run.runtimeEnvironment.type,
          slug: run.runtimeEnvironment.slug,
          userId: run.runtimeEnvironment.orgMember?.user.id,
          userName: getUsername(run.runtimeEnvironment.orgMember?.user),
        },
      },
      events: flattenTree(tree),
    };
  }
}
