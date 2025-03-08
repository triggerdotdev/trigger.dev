import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { getCurrentEnvironmentType } from "~/services/currentEnvironmentType.server";
import { getCurrentProjectId } from "~/services/currentProject.server";

export class SelectBestProjectPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ userId, request }: { userId: string; request: Request }) {
    const { project, organization } = await this.#getBestProject(request, userId);

    //try get current environment from cookie
    const environmentType = await getCurrentEnvironmentType(request);

    const environments = await this.#prismaClient.runtimeEnvironment.findMany({
      select: {
        slug: true,
        type: true,
        orgMember: {
          select: {
            userId: true,
          },
        },
      },
      where: {
        projectId: project.id,
      },
    });

    const relevantEnvironments = environments.filter((env) => env.type === environmentType);

    if (relevantEnvironments.length === 0) {
      const yourDevEnvironment = environments.find(
        (env) => env.type === "DEVELOPMENT" && env.orgMember?.userId === userId
      );
      if (yourDevEnvironment) {
        return { project, organization, environment: yourDevEnvironment };
      }

      const prodEnvironment = environments.find((env) => env.type === "PRODUCTION");
      if (prodEnvironment) {
        return { project, organization, environment: prodEnvironment };
      }

      throw new Error("No environments found");
    }

    if (relevantEnvironments.length === 1) {
      return { project, organization, environment: environments[0] };
    }

    const yourDevEnvironment = environments.find(
      (env) => env.type === "DEVELOPMENT" && env.orgMember?.userId === userId
    );
    if (yourDevEnvironment) {
      return { project, organization, environment: yourDevEnvironment };
    }

    const prodEnvironment = environments.find((env) => env.type === "PRODUCTION");
    if (prodEnvironment) {
      return { project, organization, environment: prodEnvironment };
    }

    throw new Error("No environments found");
  }

  async #getBestProject(request: Request, userId: string) {
    //try get current project from cookie
    const projectId = await getCurrentProjectId(request);

    if (projectId) {
      const project = await this.#prismaClient.project.findUnique({
        where: { id: projectId, deletedAt: null, organization: { members: { some: { userId } } } },
        include: {
          organization: true,
          environments: {
            select: {
              type: true,
              slug: true,
              orgMember: {
                select: {
                  userId: true,
                },
              },
            },
          },
        },
      });
      if (project) {
        return { project, organization: project.organization };
      }
    }

    //failing that, we pick the most recently modified project
    const projects = await this.#prismaClient.project.findMany({
      include: {
        organization: true,
      },
      where: {
        deletedAt: null,
        organization: {
          members: { some: { userId } },
        },
      },
      orderBy: {
        updatedAt: "desc",
      },
      take: 1,
    });

    if (projects.length === 0) {
      throw new Response("Not Found", { status: 404 });
    }

    return { project: projects[0], organization: projects[0].organization };
  }
}
