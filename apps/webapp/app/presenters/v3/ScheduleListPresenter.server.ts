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
  active: boolean;
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

    //do this here to protect against SQL injection
    search = search && search !== "" ? `%${search}%` : undefined;

    const totalCount = await this.#prismaClient.taskSchedule.count({
      where: {
        projectId: project.id,
        taskIdentifier: tasks ? { in: tasks } : undefined,
        instances: {
          some: {
            environmentId: environments ? { in: environments } : undefined,
          },
        },
        AND: search
          ? {
              OR: [
                {
                  externalId: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  friendlyId: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  deduplicationKey: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  cron: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : undefined,
      },
    });

    const rawSchedules = await this.#prismaClient.taskSchedule.findMany({
      select: {
        id: true,
        friendlyId: true,
        taskIdentifier: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        cron: true,
        externalId: true,
        instances: {
          select: {
            environmentId: true,
          },
        },
        active: true,
      },
      where: {
        projectId: project.id,
        taskIdentifier: tasks ? { in: tasks } : undefined,
        instances: environments
          ? {
              some: {
                environmentId: environments ? { in: environments } : undefined,
              },
            }
          : undefined,
        AND: search
          ? {
              OR: [
                {
                  externalId: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  friendlyId: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  deduplicationKey: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
                {
                  cron: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : undefined,
      },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });

    const schedules = rawSchedules.map((schedule) => {
      const nextRun = parseExpression(schedule.cron).next().toISOString();
      const cronDescription = cronstrue.toString(schedule.cron);

      return {
        id: schedule.id,
        friendlyId: schedule.friendlyId,
        taskIdentifier: schedule.taskIdentifier,
        deduplicationKey: schedule.deduplicationKey,
        userProvidedDeduplicationKey: schedule.userProvidedDeduplicationKey,
        cron: schedule.cron,
        cronDescription,
        active: schedule.active,
        externalId: schedule.externalId,
        nextRun: new Date(nextRun),
        environments: schedule.instances.map((instance) => {
          const environment = project.environments.find((env) => env.id === instance.environmentId);
          if (!environment) {
            throw new Error(
              `Environment not found for TaskScheduleInstance env: ${instance.environmentId}`
            );
          }

          return {
            id: instance.environmentId,
            type: environment.type,
            userName:
              environment.orgMember?.user.id === userId
                ? undefined
                : getUsername(environment.orgMember?.user),
          };
        }),
      };
    });

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
