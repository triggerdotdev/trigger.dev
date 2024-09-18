import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";
import { filterOrphanedEnvironments, sortEnvironments } from "~/utils/environmentSort";
import { EnvironmentVariablesRepository } from "~/v3/environmentVariables/environmentVariablesRepository.server";

type Result = Awaited<ReturnType<EnvironmentVariablesPresenter["call"]>>;
export type EnvironmentVariableWithSetValues = Result["environmentVariables"][number];

export class EnvironmentVariablesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, projectSlug }: { userId: User["id"]; projectSlug: Project["slug"] }) {
    const project = await this.#prismaClient.project.findUnique({
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

    if (!project) {
      throw new Error("Project not found");
    }

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

    const sortedEnvironments = sortEnvironments(filterOrphanedEnvironments(environments));

    const repository = new EnvironmentVariablesRepository(this.#prismaClient);
    const variables = await repository.getProject(project.id);

    return {
      environmentVariables: environmentVariables.map((environmentVariable) => {
        const variable = variables.find((v) => v.key === environmentVariable.key);

        return {
          id: environmentVariable.id,
          key: environmentVariable.key,
          values: sortedEnvironments.reduce((previous, env) => {
            const val = variable?.values.find((v) => v.environment.id === env.id);
            previous[env.id] = {
              value: val?.value,
              environment: { type: env.type, id: env.id },
            };
            return { ...previous };
          }, {} as Record<string, { value: string | undefined; environment: { type: string; id: string } }>),
        };
      }),
      environments: sortedEnvironments
        .filter((e) => e.orgMember?.userId === userId || e.orgMember === null)
        .map((environment) => ({
          id: environment.id,
          type: environment.type,
        })),
      hasStaging: environments.some((environment) => environment.type === "STAGING"),
    };
  }
}
