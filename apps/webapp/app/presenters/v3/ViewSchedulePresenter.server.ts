import { ScheduleObject } from "@trigger.dev/core/v3";
import { PrismaClient, prisma } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { nextScheduledTimestamps } from "~/v3/utils/calculateNextSchedule.server";
import { RunListPresenter } from "./RunListPresenter.server";

type ViewScheduleOptions = {
  userId?: string;
  projectId: string;
  friendlyId: string;
  environmentId: string;
};

export class ViewSchedulePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectId, friendlyId, environmentId }: ViewScheduleOptions) {
    const schedule = await this.#prismaClient.taskSchedule.findFirst({
      select: {
        id: true,
        type: true,
        friendlyId: true,
        generatorExpression: true,
        generatorDescription: true,
        timezone: true,
        externalId: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        taskIdentifier: true,
        project: {
          select: {
            id: true,
          },
        },
        instances: {
          select: {
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
      where: {
        friendlyId,
        projectId,
      },
    });

    if (!schedule) {
      return;
    }

    const nextRuns = schedule.active
      ? nextScheduledTimestamps(schedule.generatorExpression, schedule.timezone, new Date(), 5)
      : [];

    const runPresenter = new RunListPresenter(this.#prismaClient);

    const { runs } = await runPresenter.call(environmentId, {
      projectId: schedule.project.id,
      scheduleId: schedule.id,
      pageSize: 5,
    });

    return {
      schedule: {
        ...schedule,
        timezone: schedule.timezone,
        cron: schedule.generatorExpression,
        cronDescription: schedule.generatorDescription,
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

  public toJSONResponse(result: NonNullable<Awaited<ReturnType<ViewSchedulePresenter["call"]>>>) {
    const response: ScheduleObject = {
      id: result.schedule.friendlyId,
      type: result.schedule.type,
      task: result.schedule.taskIdentifier,
      active: result.schedule.active,
      nextRun: result.schedule.nextRuns[0],
      generator: {
        type: "CRON",
        expression: result.schedule.cron,
        description: result.schedule.cronDescription,
      },
      timezone: result.schedule.timezone,
      externalId: result.schedule.externalId ?? undefined,
      deduplicationKey: result.schedule.userProvidedDeduplicationKey
        ? result.schedule.deduplicationKey ?? undefined
        : undefined,
      environments: result.schedule.instances.map((instance) => ({
        id: instance.environment.id,
        type: instance.environment.type,
      })),
    };

    return response;
  }
}
