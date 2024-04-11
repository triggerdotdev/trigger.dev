import { Prisma, TaskRunStatus } from "@trigger.dev/database";
import { ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";
import { CANCELLABLE_STATUSES } from "~/v3/services/cancelTaskRun.server";

type ScheduleListOptions = {
  userId: string;
  projectSlug: string;
  pageSize?: number;
} & ScheduleListFilters;

const DEFAULT_PAGE_SIZE = 20;

export type ScheduleList = Awaited<ReturnType<ScheduleListPresenter["call"]>>;
export type ScheduleListItem = ScheduleList["schedules"][0];
export type ScheduleListAppliedFilters = ScheduleList["filters"];

export class ScheduleListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectSlug,
    tasks,
    environments,
    enabled,
    search,
    page,
    pageSize = DEFAULT_PAGE_SIZE,
  }: ScheduleListOptions) {
    const hasFilters =
      tasks !== undefined ||
      environments !== undefined ||
      enabled !== undefined ||
      (search !== undefined && search !== "");

    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
        environments: {
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
        slug: projectSlug,
      },
    });

    //get all possible scheduled tasks
    const possibleTasks = await this.#prismaClient.$queryRaw<{ slug: string }[]>`
    SELECT DISTINCT(slug)
    FROM "BackgroundWorkerTask"
    WHERE "projectId" = ${project.id}
    AND "triggerSource" = 'SCHEDULED';
    `;

    const totalCount = await this.#prismaClient.taskSchedule.count({
      where: {
        projectId: project.id,
      },
    });

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      schedules: [],
      possibleTasks: possibleTasks.map((task) => task.slug),
      hasFilters,
      filters: {
        tasks,
        environments,
        enabled,
        search,
      },
    };
  }
}
