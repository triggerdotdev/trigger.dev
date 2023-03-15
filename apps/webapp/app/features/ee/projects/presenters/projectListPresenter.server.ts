import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export type ProjectListItem = Awaited<
  ReturnType<ProjectListPresenter["projectsForOrg"]>
>[number];

export class ProjectListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(userId: string, organizationSlug: string) {
    const projects = await this.projectsForOrg(organizationSlug);

    const appAuthorizationCount =
      await this.#prismaClient.gitHubAppAuthorization.count({
        where: {
          user: {
            id: userId,
          },
        },
      });

    return {
      organizationSlug,
      projects,
      appAuthorizationCount,
    };
  }

  private async projectsForOrg(organizationSlug: string) {
    return await this.#prismaClient.repositoryProject.findMany({
      where: {
        organization: {
          slug: organizationSlug,
        },
        status: {
          not: "DISABLED",
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        currentDeployment: true,
      },
      take: 30,
    });
  }
}
