import type { ScheduleObject } from "@trigger.dev/core/v3";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { clickhouseFactory } from "~/services/clickhouse/clickhouseFactoryInstance.server";
import { NextRunListPresenter } from "./NextRunListPresenter.server";
import { scheduleWhereClause } from "~/models/schedules.server";
import { calculateNextScheduleRunTimes, formatScheduleWindow } from "~/v3/scheduleWindow.server";
import { env } from "~/env.server";

type ViewScheduleOptions = {
  userId?: string;
  projectId: string;
  friendlyId: string;
  environmentId: string;
  includeRunHistory?: boolean;
};

export class ViewSchedulePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    projectId,
    friendlyId,
    environmentId,
    includeRunHistory = true,
  }: ViewScheduleOptions) {
    const schedule = await this.#prismaClient.taskSchedule.findFirst({
      select: {
        id: true,
        type: true,
        friendlyId: true,
        generatorExpression: true,
        generatorDescription: true,
        timezone: true,
        windowDurationSeconds: true,
        windowPercentage: true,
        externalId: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        taskIdentifier: true,
        project: {
          select: {
            id: true,
            organizationId: true,
          },
        },
        instances: {
          select: {
            environmentId: true,
            schedulePhase: true,
            environment: {
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
                branchName: true,
              },
            },
          },
        },
        active: true,
      },
      where: scheduleWhereClause(projectId, friendlyId),
    });

    if (!schedule) {
      return;
    }

    const instance = schedule.instances.find(
      (instance) => instance.environmentId === environmentId
    );
    if (!instance && schedule.instances.length > 0) {
      return;
    }

    const nextRuns = schedule.active
      ? calculateNextScheduleRunTimes({
          cron: schedule.generatorExpression,
          timezone: schedule.timezone,
          deduplicationKey: schedule.deduplicationKey,
          environmentId,
          schedulePhase: instance?.schedulePhase ?? null,
          phaseSecret: env.ENCRYPTION_KEY,
          windowDurationSeconds: schedule.windowDurationSeconds,
          windowPercentage: schedule.windowPercentage,
          count: 5,
        })
      : [];

    const runs = includeRunHistory
      ? await this.#getRunHistory({
          organizationId: schedule.project.organizationId,
          environmentId,
          projectId: schedule.project.id,
          scheduleId: schedule.id,
        })
      : [];

    return {
      schedule: {
        ...schedule,
        timezone: schedule.timezone,
        cron: schedule.generatorExpression,
        cronDescription: schedule.generatorDescription,
        window: formatScheduleWindow(schedule),
        nextRuns,
        runs,
        environments: schedule.instances.map((instance) => {
          const environment = instance.environment;
          return {
            ...displayableEnvironment(environment, userId),
            branchName: environment.branchName ?? undefined,
          };
        }),
      },
    };
  }

  async #getRunHistory({
    organizationId,
    environmentId,
    projectId,
    scheduleId,
  }: {
    organizationId: string;
    environmentId: string;
    projectId: string;
    scheduleId: string;
  }) {
    const clickhouse = await clickhouseFactory.getClickhouseForOrganization(
      organizationId,
      "standard"
    );
    const runPresenter = new NextRunListPresenter(this.#prismaClient, clickhouse);
    const { runs } = await runPresenter.call(organizationId, environmentId, {
      projectId,
      scheduleId,
      pageSize: 5,
      period: "31d",
    });

    return runs;
  }

  public toJSONResponse(result: NonNullable<Awaited<ReturnType<ViewSchedulePresenter["call"]>>>) {
    const response: ScheduleObject = {
      id: result.schedule.friendlyId,
      type: result.schedule.type,
      task: result.schedule.taskIdentifier,
      active: result.schedule.active,
      nextRun: result.schedule.nextRuns[0]?.nominalAt ?? null,
      nextRunEffectiveAt: result.schedule.nextRuns[0]?.effectiveAt ?? null,
      generator: {
        type: "CRON",
        expression: result.schedule.cron,
        description: result.schedule.cronDescription,
      },
      timezone: result.schedule.timezone,
      window: result.schedule.window,
      externalId: result.schedule.externalId ?? undefined,
      deduplicationKey: result.schedule.userProvidedDeduplicationKey
        ? (result.schedule.deduplicationKey ?? undefined)
        : undefined,
      environments: result.schedule.instances.map((instance) => ({
        id: instance.environment.id,
        type: instance.environment.type,
      })),
    };

    return response;
  }
}
