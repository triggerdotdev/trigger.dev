import { type RuntimeEnvironmentType } from "@trigger.dev/database";
import { type PrismaClient, prisma } from "~/db.server";
import { displayableEnvironment, findEnvironmentBySlug } from "~/models/runtimeEnvironment.server";
import { logger } from "~/services/logger.server";
import { filterOrphanedEnvironments } from "~/utils/environmentSort";
import { getTimezones } from "~/utils/timezones.server";
import { findCurrentWorkerFromEnvironment } from "~/v3/models/workerDeployment.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

type EditScheduleOptions = {
  userId: string;
  projectSlug: string;
  environmentSlug: string;
  friendlyId?: string;
};

export type EditableScheduleElements = Awaited<ReturnType<EditSchedulePresenter["call"]>>;

type Environment = {
  id: string;
  type: RuntimeEnvironmentType;
  userName?: string;
};

export class EditSchedulePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, environmentSlug, friendlyId }: EditScheduleOptions) {
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
            branchName: true,
          },
        },
      },
      where: {
        slug: projectSlug,
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const environment = await findEnvironmentBySlug(project.id, environmentSlug, userId);
    if (!environment) {
      throw new ServiceValidationError("No matching environment for project", 404);
    }

    //get the latest BackgroundWorker
    const latestWorker = await findCurrentWorkerFromEnvironment(environment, this.#prismaClient);

    //get all possible scheduled tasks
    const possibleTasks = latestWorker
      ? await this.#prismaClient.backgroundWorkerTask.findMany({
          where: {
            workerId: latestWorker.id,
            projectId: project.id,
            runtimeEnvironmentId: environment.id,
            triggerSource: "SCHEDULED",
          },
        })
      : [];

    const possibleEnvironments = filterOrphanedEnvironments(project.environments)
      .map((environment) => {
        return {
          ...displayableEnvironment(environment, userId),
          branchName: environment.branchName ?? undefined,
        };
      })
      .filter((env) => {
        if (env.type === "PREVIEW" && !env.branchName) return false;
        return true;
      });

    return {
      possibleTasks: possibleTasks.map((task) => task.slug).sort(),
      possibleEnvironments,
      possibleTimezones: getTimezones(),
      schedule: await this.#getExistingSchedule(friendlyId, possibleEnvironments),
    };
  }

  async #getExistingSchedule(scheduleId: string | undefined, possibleEnvironments: Environment[]) {
    if (!scheduleId) {
      return undefined;
    }

    const schedule = await this.#prismaClient.taskSchedule.findFirst({
      select: {
        id: true,
        type: true,
        friendlyId: true,
        generatorExpression: true,
        externalId: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        timezone: true,
        taskIdentifier: true,
        instances: {
          select: {
            environmentId: true,
          },
        },
        active: true,
      },
      where: {
        friendlyId: scheduleId,
      },
    });

    if (!schedule) {
      return undefined;
    }

    return {
      ...schedule,
      cron: schedule.generatorExpression,
      environments: schedule.instances.flatMap((instance) => {
        const environment = possibleEnvironments.find((env) => env.id === instance.environmentId);
        if (!environment) {
          logger.error(
            `EditSchedulePresenter: environment with id ${instance.environmentId} not found`
          );
          return [];
        }

        return [environment];
      }),
    };
  }
}
