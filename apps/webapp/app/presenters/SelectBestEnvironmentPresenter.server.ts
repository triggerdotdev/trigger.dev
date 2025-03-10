import { type RuntimeEnvironment, type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { type UserFromSession } from "~/services/session.server";

export type MinimumEnvironment = Pick<RuntimeEnvironment, "id" | "type" | "slug"> & {
  orgMember: null | {
    userId: string | undefined;
  };
};

export class SelectBestEnvironmentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({ user }: { user: UserFromSession }) {
    const { project, organization } = await this.getBestProject(user);
    const environment = await this.selectBestEnvironment(project.id, user, project.environments);

    return {
      project,
      organization,
      environment,
    };
  }

  async getBestProject(user: UserFromSession) {
    //try get current project from cookie
    const projectId = user.dashboardPreferences.currentProjectId;

    if (projectId) {
      const project = await this.#prismaClient.project.findUnique({
        where: {
          id: projectId,
          deletedAt: null,
          organization: { members: { some: { userId: user.id } } },
        },
        include: {
          organization: true,
          environments: {
            select: {
              id: true,
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
        environments: {
          select: {
            id: true,
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
      where: {
        deletedAt: null,
        organization: {
          members: { some: { userId: user.id } },
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

  async selectBestEnvironment(
    projectId: string,
    user: UserFromSession,
    environments: MinimumEnvironment[]
  ): Promise<MinimumEnvironment> {
    //try get current environment from prefs
    const currentEnvironmentId: string | undefined =
      user.dashboardPreferences.projects[projectId]?.currentEnvironment.id;

    const currentEnvironment = environments.find((env) => env.id === currentEnvironmentId);
    if (currentEnvironment) {
      return currentEnvironment;
    }

    //otherwise show their dev environment
    const yourDevEnvironment = environments.find(
      (env) => env.type === "DEVELOPMENT" && env.orgMember?.userId === user.id
    );
    if (yourDevEnvironment) {
      return yourDevEnvironment;
    }

    //otherwise show their prod environment
    const prodEnvironment = environments.find((env) => env.type === "PRODUCTION");
    if (prodEnvironment) {
      return prodEnvironment;
    }

    throw new Error("No environments found");
  }
}
