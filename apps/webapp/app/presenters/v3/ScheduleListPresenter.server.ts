import { type RuntimeEnvironmentType, type ScheduleType, boundedIn } from "@trigger.dev/database";
import { type ScheduleListFilters } from "~/components/runs/v3/ScheduleFilters";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getTaskIdentifiers } from "~/models/task.server";
import { getCurrentPlan, getPlans } from "~/services/platform.v3.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { formatScheduleWindow } from "~/v3/scheduleWindow.server";
import { CheckScheduleService } from "~/v3/services/checkSchedule.server";
import { resolveScheduleTimings } from "~/v3/scheduleTimings.server";
import { env } from "~/env.server";
import { BasePresenter } from "./basePresenter.server";

type ScheduleListOptions = {
  projectId: string;
  environmentId: string;
  userId?: string;
  pageSize?: number;
  /**
   * Walking each cron backwards to approximate "last run" costs an order of
   * magnitude more than everything else here, so it is opt-in: only the
   * dashboard renders the column. Defaults off.
   */
  includeLastRun?: boolean;
} & ScheduleListFilters;

const DEFAULT_PAGE_SIZE = 20;

type ScheduleListItem = {
  id: string;
  type: ScheduleType;
  friendlyId: string;
  taskIdentifier: string;
  deduplicationKey: string | null;
  userProvidedDeduplicationKey: boolean;
  cron: string;
  cronDescription: string;
  timezone: string;
  window?: string;
  externalId: string | null;
  nextRun: Date;
  nextRunEffectiveAt: Date;
  lastRun: Date | undefined;
  active: boolean;
  environments: {
    id: string;
    type: RuntimeEnvironmentType;
    userName?: string;
    branchName?: string;
  }[];
};

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
    includeLastRun = false,
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

    // Two platform RPCs in parallel. We derive `limit` from `currentPlan`
    // rather than calling `getLimit` separately (which would re-issue
    // `client.currentPlan` upstream — same data fetched twice). The
    // scheduled-task route awaits this presenter synchronously, so every ms
    // here is TTFB.
    const [currentPlan, plans] = await Promise.all([
      getCurrentPlan(project.organizationId),
      getPlans(),
    ]);

    const planLimit = currentPlan?.v3Subscription?.plan?.limits.schedules?.number;
    const limit = typeof planLimit === "number" ? planLimit : 100_000_000;
    const extraSchedules = currentPlan?.v3Subscription?.addOns?.schedules?.purchased ?? 0;
    const canPurchaseSchedules =
      currentPlan?.v3Subscription?.plan?.limits.schedules.canExceed === true;
    const maxScheduleQuota = currentPlan?.v3Subscription?.addOns?.schedules?.quota ?? 0;
    const planScheduleLimit = limit - extraSchedules;
    const schedulePricing = plans?.addOnPricing.schedules ?? null;

    const purchaseInfo = {
      canPurchaseSchedules,
      extraSchedules,
      maxScheduleQuota,
      planScheduleLimit,
      schedulePricing,
    };

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
        ...purchaseInfo,
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
        taskIdentifier: tasks ? { in: boundedIn(tasks) } : undefined,
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
        windowDurationSeconds: true,
        windowPercentage: true,
        externalId: true,
        instances: {
          select: {
            environmentId: true,
            schedulePhase: true,
          },
        },
        active: true,
        createdAt: true,
        updatedAt: true,
      },
      where: {
        projectId: project.id,
        taskIdentifier: tasks ? { in: boundedIn(tasks) } : undefined,
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

    const instances = rawSchedules.map((schedule) => {
      const instance = schedule.instances.find(
        (instance) => instance.environmentId === environmentId
      );
      if (!instance) {
        throw new Error(`Schedule instance not found for environment: ${environmentId}`);
      }
      return instance;
    });

    const timings = resolveScheduleTimings(
      rawSchedules.map((schedule, index) => ({
        cron: schedule.generatorExpression,
        timezone: schedule.timezone,
        deduplicationKey: schedule.deduplicationKey,
        environmentId,
        schedulePhase: instances[index].schedulePhase,
        windowDurationSeconds: schedule.windowDurationSeconds,
        windowPercentage: schedule.windowPercentage,
        active: schedule.active,
        updatedAt: schedule.updatedAt,
      })),
      { phaseSecret: env.ENCRYPTION_KEY, includeLastRun }
    );

    const schedules: ScheduleListItem[] = rawSchedules.map((schedule, index) => {
      const { nextRun, nextRunEffectiveAt, lastRun } = timings[index];

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
        window: formatScheduleWindow(schedule),
        active: schedule.active,
        externalId: schedule.externalId,
        lastRun,
        nextRun,
        nextRunEffectiveAt,
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
      ...purchaseInfo,
      filters: {
        tasks,
        search,
      },
    };
  }
}
