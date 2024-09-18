import { Prisma, RuntimeEnvironmentType, ScheduleType } from "@trigger.dev/database";
import { ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getCurrentPlan, getLimit, getLimits } from "~/services/platform.v3.server";
import { calculateNextScheduledTimestamp } from "~/v3/utils/calculateNextSchedule.server";
import { BasePresenter } from "./basePresenter.server";

type ScheduleListOptions = {
  projectId: string;
  userId?: string;
  pageSize?: number;
} & ScheduleListFilters;

const DEFAULT_PAGE_SIZE = 20;

export type ScheduleListItem = {
  id: string;
  type: ScheduleType;
  friendlyId: string;
  taskIdentifier: string;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  cron: string;
  cronDescription: string;
  timezone: string;
  externalId: string | null;
  nextRun: Date;
  lastRun: Date | undefined;
  active: boolean;
  environments: {
    id: string;
    type: RuntimeEnvironmentType;
    userName?: string;
  }[];
};
export type ScheduleList = Awaited<ReturnType<ScheduleListPresenter["call"]>>;
export type ScheduleListAppliedFilters = ScheduleList["filters"];

export class ScheduleListPresenter extends BasePresenter {
  public async call({
    userId,
    projectId,
    tasks,
    environments,
    search,
    page,
    type,
    pageSize = DEFAULT_PAGE_SIZE,
  }: ScheduleListOptions) {
    const hasFilters =
      type !== undefined ||
      tasks !== undefined ||
      environments !== undefined ||
      (search !== undefined && search !== "");

    const filterType =
      type === "declarative" ? "DECLARATIVE" : type === "imperative" ? "IMPERATIVE" : undefined;

    // Find the project scoped to the organization
    const project = await this._replica.project.findFirstOrThrow({
      select: {
        id: true,
        organizationId: true,
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
        id: projectId,
      },
    });

    const schedulesCount = await this._prisma.taskSchedule.count({
      where: {
        projectId,
      },
    });

    //get all possible scheduled tasks
    const possibleTasks = await this._replica.backgroundWorkerTask.findMany({
      distinct: ["slug"],
      where: {
        projectId: project.id,
        triggerSource: "SCHEDULED",
      },
    });

    //do this here to protect against SQL injection
    search = search && search !== "" ? `%${search}%` : undefined;

    const totalCount = await this._replica.taskSchedule.count({
      where: {
        projectId: project.id,
        taskIdentifier: tasks ? { in: tasks } : undefined,
        instances: {
          some: {
            environmentId: environments ? { in: environments } : undefined,
          },
        },
        type: filterType,
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
                  generatorExpression: {
                    contains: search,
                    mode: "insensitive",
                  },
                },
              ],
            }
          : undefined,
      },
    });

    const rawSchedules = await this._replica.taskSchedule.findMany({
      select: {
        id: true,
        type: true,
        friendlyId: true,
        taskIdentifier: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        generatorExpression: true,
        generatorDescription: true,
        timezone: true,
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
        type: filterType,
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
                  generatorExpression: {
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

    const latestRuns =
      rawSchedules.length > 0
        ? await this._replica.$queryRaw<{ scheduleId: string; createdAt: Date }[]>`
    SELECT t."scheduleId", t."createdAt"
    FROM (
      SELECT "scheduleId", MAX("createdAt") as "LatestRun"
      FROM ${sqlDatabaseSchema}."TaskRun"
      WHERE "scheduleId" IN (${Prisma.join(rawSchedules.map((s) => s.id))})
      GROUP BY "scheduleId"
    ) r
    JOIN ${sqlDatabaseSchema}."TaskRun" t
    ON t."scheduleId" = r."scheduleId" AND t."createdAt" = r."LatestRun";`
        : [];

    const schedules: ScheduleListItem[] = rawSchedules.map((schedule) => {
      const latestRun = latestRuns.find((r) => r.scheduleId === schedule.id);

      return {
        id: schedule.id,
        type: schedule.type,
        friendlyId: schedule.friendlyId,
        taskIdentifier: schedule.taskIdentifier,
        deduplicationKey: schedule.deduplicationKey,
        userProvidedDeduplicationKey: schedule.userProvidedDeduplicationKey,
        cron: schedule.generatorExpression,
        cronDescription: schedule.generatorDescription,
        timezone: schedule.timezone,
        active: schedule.active,
        externalId: schedule.externalId,
        lastRun: latestRun?.createdAt,
        nextRun: calculateNextScheduledTimestamp(schedule.generatorExpression, schedule.timezone),
        environments: schedule.instances.map((instance) => {
          const environment = project.environments.find((env) => env.id === instance.environmentId);
          if (!environment) {
            throw new Error(
              `Environment not found for TaskScheduleInstance env: ${instance.environmentId}`
            );
          }

          return displayableEnvironment(environment, userId);
        }),
      };
    });

    const limit = await getLimit(project.organizationId, "schedules", 100_000_000);

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      totalCount: totalCount,
      schedules,
      possibleTasks: possibleTasks.map((task) => task.slug),
      possibleEnvironments: project.environments.map((environment) => {
        return displayableEnvironment(environment, userId);
      }),
      hasFilters,
      limits: {
        used: schedulesCount,
        limit,
      },
      filters: {
        tasks,
        environments,
        search,
      },
    };
  }
}
