import { RuntimeEnvironmentType } from "@trigger.dev/database";
import { parseExpression } from "cron-parser";
import cronstrue from "cronstrue";
import { PrismaClient, prisma } from "~/db.server";
import { env } from "~/env.server";
import { RunListPresenter } from "./RunListPresenter.server";

type ViewScheduleOptions = {
  userId: string;
  projectSlug: string;
  friendlyId: string;
};

type Environment = {
  id: string;
  type: RuntimeEnvironmentType;
  userName?: string;
};

export class ViewSchedulePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug, friendlyId }: ViewScheduleOptions) {
    // Find the project scoped to the organization
    const project = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
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
            environment: {
              select: {
                id: true,
                type: true,
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
        },
        active: true,
      },
      where: {
        friendlyId,
      },
    });

    if (!schedule) {
      return;
    }

    const expression = parseExpression(schedule.cron, { utc: true });
    const cronDescription = cronstrue.toString(schedule.cron);
    const nextRuns = schedule.active
      ? Array.from({ length: 5 }, (_, i) => {
          const utc = expression.next().toDate();
          return utc;
        })
      : [];

    const runPresenter = new RunListPresenter(this.#prismaClient);
    const { runs } = await runPresenter.call({
      userId,
      projectSlug,
      pageSize: 5,
    });

    return {
      schedule: {
        ...schedule,
        cronDescription,
        nextRuns,
        runs,
        environments: schedule.instances.map((instance) => {
          const environment = instance.environment;
          let userName: undefined | string;
          if (environment.orgMember) {
            if (environment.orgMember.user.id !== userId) {
              userName =
                environment.orgMember.user.displayName ??
                environment.orgMember.user.name ??
                undefined;
            }
          }

          return {
            id: environment.id,
            type: environment.type,
            userName,
          };
        }),
      },
    };
  }
}
