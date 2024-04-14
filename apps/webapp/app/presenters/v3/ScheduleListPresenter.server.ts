import { Prisma, RuntimeEnvironmentType } from "@trigger.dev/database";
import { parseExpression } from "cron-parser";
import { ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { PrismaClient, prisma } from "~/db.server";
import { getUsername } from "~/utils/username";
import cronstrue from "cronstrue";
import { logger } from "~/services/logger.server";

type ScheduleListOptions = {
  userId: string;
  projectSlug: string;
  pageSize?: number;
} & ScheduleListFilters;

const DEFAULT_PAGE_SIZE = 20;

export type ScheduleListItem = {
  id: string;
  friendlyId: string;
  taskIdentifier: string;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  cron: string;
  cronDescription: string;
  externalId: string | null;
  nextRun: Date;
  environments: {
    id: string;
    type: RuntimeEnvironmentType;
    userName?: string;
  }[];
};
export type ScheduleList = Awaited<ReturnType<ScheduleListPresenter["call"]>>;
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
    search,
    page,
    pageSize = DEFAULT_PAGE_SIZE,
  }: ScheduleListOptions) {
    const hasFilters =
      tasks !== undefined || environments !== undefined || (search !== undefined && search !== "");

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

    //get the schedules
    const rawSchedules = await this.#prismaClient.$queryRaw<
      {
        id: string;
        friendlyId: string;
        taskIdentifier: string;
        deduplicationKey: string | null;
        userProvidedDeduplicationKey: boolean;
        cron: string;
        externalId: string | null;
        environmentId: string;
      }[]
    >`SELECT ts.id, ts."friendlyId", ts."taskIdentifier", ts."deduplicationKey", ts."userProvidedDeduplicationKey", ts.cron, ts."externalId", ti."environmentId"
    FROM "TaskSchedule" ts
    JOIN "TaskScheduleInstance" ti ON ts.id = ti."taskScheduleId"
    WHERE ts."projectId" = ${project.id}
    ${
      environments && environments.length > 0
        ? Prisma.sql`AND ti."environmentId" IN (${Prisma.join(environments)})`
        : Prisma.empty
    }
    ${
      tasks && tasks.length > 0
        ? Prisma.sql`AND ts."taskIdentifier" IN (${Prisma.join(tasks)})`
        : Prisma.empty
    }
    ${
      search && search !== ""
        ? Prisma.sql`AND (ts."externalId" ILIKE ${`%${search}%`} OR ts."friendlyId" ILIKE ${`%${search}%`} OR ts."deduplicationKey" ILIKE ${`%${search}%`} OR ts."cron" ILIKE ${`%${search}%`})`
        : Prisma.empty
    };`;

    //rawSchedules have environmentId, we want to use the project.environments to collapse the schedules to have an environments array with the environment data
    const schedules = rawSchedules.reduce((acc, schedule) => {
      const existingSchedule = acc.find((s) => s.id === schedule.id);
      const environment = project.environments.find((env) => env.id === schedule.environmentId);
      if (!environment) {
        return acc;
      }

      if (existingSchedule) {
        existingSchedule.environments.push({
          id: schedule.environmentId,
          type: environment.type,
          userName:
            environment.orgMember?.user.id === userId
              ? undefined
              : getUsername(environment.orgMember?.user),
        });
      } else {
        const nextRun = parseExpression(schedule.cron).next().toISOString();
        const cronDescription = cronstrue.toString(schedule.cron);

        acc.push({
          id: schedule.id,
          friendlyId: schedule.friendlyId,
          taskIdentifier: schedule.taskIdentifier,
          deduplicationKey: schedule.deduplicationKey,
          userProvidedDeduplicationKey: schedule.userProvidedDeduplicationKey,
          cron: schedule.cron,
          cronDescription,
          externalId: schedule.externalId,
          nextRun: new Date(nextRun),
          environments: [
            {
              id: schedule.environmentId,
              type: environment.type,
              userName:
                environment.orgMember?.user.id === userId
                  ? undefined
                  : getUsername(environment.orgMember?.user),
            },
          ],
        });
      }
      return acc;
    }, [] as ScheduleListItem[]);

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      schedules,
      possibleTasks: possibleTasks.map((task) => task.slug),
      possibleEnvironments: project.environments.map((environment) => {
        return {
          id: environment.id,
          type: environment.type,
          userName:
            environment.orgMember?.user.id === userId
              ? undefined
              : getUsername(environment.orgMember?.user),
        };
      }),
      hasFilters,
      filters: {
        tasks,
        environments,
        search,
      },
    };
  }
}
