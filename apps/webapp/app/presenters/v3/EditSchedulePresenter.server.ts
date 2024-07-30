import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { displayableEnvironment } from "~/models/runtimeEnvironment.server";
import { getTimezones } from "~/utils/timezones.server";

type EditScheduleOptions = {
  userId: string;
  projectSlug: string;
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

  public async call({ userId, projectSlug, friendlyId }: EditScheduleOptions) {
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
        organization: {
          members: {
            some: {
              userId,
            },
          },
        },
      },
    });

    const possibleTasks = await this.#prismaClient.backgroundWorkerTask.findMany({
      distinct: ["slug"],
      where: {
        projectId: project.id,
        triggerSource: "SCHEDULED",
      },
    });

    const possibleEnvironments = project.environments.map((environment) => {
      return displayableEnvironment(environment, userId);
    });

    return {
      possibleTasks: possibleTasks.map((task) => task.slug),
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
      environments: schedule.instances.map((instance) => {
        const environment = possibleEnvironments.find((env) => env.id === instance.environmentId);
        if (!environment) {
          throw new Error(`Environment with id ${instance.environmentId} not found`);
        }

        return environment;
      }),
    };
  }
}
