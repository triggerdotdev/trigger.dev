import { PrismaClient, prisma } from "~/db.server";

type EditScheduleOptions = {
  userId: string;
  projectSlug: string;
  friendlyId?: string;
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

    const possibleTasks = await this.#prismaClient.$queryRaw<{ slug: string }[]>`
    SELECT DISTINCT(slug)
    FROM "BackgroundWorkerTask"
    WHERE "projectId" = ${project.id} 
    AND "triggerSource" = 'SCHEDULED';
    `;

    return {
      possibleTasks: possibleTasks.map((task) => task.slug),
      possibleEnvironments: project.environments.map((environment) => ({
        id: environment.id,
        type: environment.type,
        userName: environment.orgMember?.user.displayName ?? undefined,
      })),
      schedule: await this.#getExistingSchedule(friendlyId),
    };
  }

  async #getExistingSchedule(scheduleId: string | undefined) {
    if (!scheduleId) {
      return undefined;
    }

    const schedule = await this.#prismaClient.taskSchedule.findFirst({
      select: {
        id: true,
        friendlyId: true,
        cron: true,
        externalId: true,
        deduplicationKey: true,
        userProvidedDeduplicationKey: true,
        taskIdentifier: true,
        instances: {
          select: {
            environmentId: true,
          },
        },
      },
      where: {
        friendlyId: scheduleId,
      },
    });

    if (!schedule) {
      return undefined;
    }

    return schedule;
  }
}
