import { type RuntimeEnvironmentType, type ScheduleType } from "@trigger.dev/database";
import { type ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getTaskIdentifiers } from "~/models/task.server";
import { getLimit } from "~/services/platform.v3.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { CheckScheduleService } from "~/v3/services/checkSchedule.server";
import {
  calculateNextScheduledTimestampFromNow,
  previousScheduledTimestamp,
} from "~/v3/utils/calculateNextSchedule.server";
import { BasePresenter } from "./basePresenter.server";

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
    branchName?: string;
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
            branchName: true,
            archivedAt: true,
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
      projectId,
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
    const allIdentifiers = await getTaskIdentifiers(environmentId);
    const possibleTasks = allIdentifiers
      .filter((t) => t.triggerSource === "SCHEDULED" && t.isInLatestDeployment)
      .map((t) => ({ slug: t.slug }));

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
        createdAt: true,
        updatedAt: true,
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
      // Approximate "last run" from the cron's previous slot. Skip inactive
      // schedules — the cron's previous slot reflects what *would* have
      // fired, but a deactivated schedule didn't actually fire there. Skip
      // when the cron's previous slot predates `updatedAt`: any config
      // change (cron edited, timezone changed, deactivate/reactivate)
      // bumps updatedAt, and a slot from before the most recent change
      // didn't fire under the current configuration. cron-parser throws
      // on malformed expressions, so degrade to undefined per-row rather
      // than failing the whole list. UI is best-effort; the runs page is
      // the source of truth.
      let lastRun: Date | undefined;
      if (schedule.active) {
        try {
          const cronPrev = previousScheduledTimestamp(
            schedule.generatorExpression,
            schedule.timezone
          );
          lastRun = cronPrev.getTime() > schedule.updatedAt.getTime() ? cronPrev : undefined;
        } catch {
          lastRun = undefined;
        }
      }

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
        lastRun,
        nextRun: calculateNextScheduledTimestampFromNow(
          schedule.generatorExpression,
          schedule.timezone
        ),
        environments: schedule.instances.map((instance) => {
          const environment = project.environments.find((env) => env.id === instance.environmentId);
          if (!environment) {
            throw new Error(
              `Environment not found for TaskScheduleInstance env: ${instance.environmentId}`
            );
          }

          return {
            ...displayableEnvironment(environment, userId),
            branchName: environment.branchName ?? undefined,
          };
        }),
      };
    });

    return {
      currentPage: page,
      totalPages: Math.ceil(totalCount / pageSize),
      totalCount: totalCount,
      schedules,
      possibleTasks: possibleTasks.map((task) => task.slug),
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
