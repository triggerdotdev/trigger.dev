import { Prisma, type RuntimeEnvironmentType, type ScheduleType } from "@trigger.dev/database";
import { type ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { sqlDatabaseSchema } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getLimit } from "~/services/platform.v3.server";
import { CheckScheduleService } from "~/v3/services/checkSchedule.server";
import { calculateNextScheduledTimestamp } from "~/v3/utils/calculateNextSchedule.server";
import { BasePresenter } from "./basePresenter.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

type ScheduleListOptions = {
  projectId: string;
  environmentId: string;
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
    environmentId,
    tasks,
    search,
    page,
    type,
    pageSize = DEFAULT_PAGE_SIZE,
  }: ScheduleListOptions) {
    const hasFilters =
      type !== undefined || tasks !== undefined || (search !== undefined && search !== "");

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

    const environment = project.environments.find((env) => env.id === environmentId);
    if (!environment) {
      throw new ServiceValidationError("No matching environment for project", 404);
    }

    const schedulesCount = await CheckScheduleService.getUsedSchedulesCount({
      prisma: this._replica,
      environments: project.environments,
    });

    const limit = await getLimit(project.organizationId, "schedules", 100_000_000);

    //get the latest BackgroundWorker
    const latestWorker = await findCurrentWorkerFromEnvironment(environment, this._replica);
    if (!latestWorker) {
      return {
        currentPage: 1,
        totalPages: 1,
        totalCount: 0,
        schedules: [],
        possibleTasks: [],
        hasFilters,
        limits: {
          used: schedulesCount,
          limit,
        },
        filters: {
          tasks,
          search,
        },
      };
    }

    //get all possible scheduled tasks
    const possibleTasks = await this._replica.backgroundWorkerTask.findMany({
      where: {
        workerId: latestWorker.id,
        projectId: project.id,
        runtimeEnvironmentId: environmentId,
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
            environmentId,
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
        lastRunTriggeredAt: true,
        createdAt: true,
      },
      where: {
        projectId: project.id,
        taskIdentifier: tasks ? { in: tasks } : undefined,
        instances: {
          some: {
            environmentId,
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
      orderBy: {
        createdAt: "desc",
      },
      take: pageSize,
      skip: (page - 1) * pageSize,
    });

    const schedules: ScheduleListItem[] = rawSchedules.map((schedule) => {
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
        lastRun: schedule.lastRunTriggeredAt ?? undefined,
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

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      totalCount: totalCount,
      schedules,
      possibleTasks: possibleTasks.map((task) => task.slug).sort((a, b) => a.localeCompare(b)),
      hasFilters,
      limits: {
        used: schedulesCount,
        limit,
      },
      filters: {
        tasks,
        search,
      },
    };
  }
}
