import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { sortEnvironments } from "~/services/environmentSort.server";

export class EnvironmentVariablesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const environmentVariables = await this.#prismaClient.environmentVariable.findMany({
      select: {
        id: true,
        key: true,
        values: {
          select: {
            id: true,
            environmentId: true,
            valueReference: {
              select: {
                key: true,
              },
            },
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
      },
    });

    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        id: true,
        type: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        project: {
          slug: projectSlug,
        },
      },
    });

    const sortedEnvironments = sortEnvironments(environments).filter(
      (e) => e.orgMember?.userId === userId || e.orgMember === null
    );

    return {
      environmentVariables: environmentVariables.map((environmentVariable) => ({
        id: environmentVariable.id,
        key: environmentVariable.key,
        values: sortedEnvironments.reduce((previous, env) => {
          const val = environmentVariable.values.find((v) => v.environmentId === env.id);
          previous[env.id] = {
            value: val?.valueReference?.key,
            environment: { type: env.type },
          };
          return { ...previous };
        }, {} as Record<string, { value: string | undefined; environment: { type: string } }>),
      })),
      environments: sortedEnvironments.map((environment) => ({
        id: environment.id,
        type: environment.type,
      })),
    };
  }
}
