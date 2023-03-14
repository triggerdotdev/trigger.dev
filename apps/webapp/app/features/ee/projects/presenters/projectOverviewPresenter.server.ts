import { LIVE_ENVIRONMENT } from "~/consts";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getEnvironmentForOrganization } from "~/models/runtimeEnvironment.server";
import { WorkflowsPresenter } from "~/presenters/workflowsPresenter.server";

export class ProjectOverviewPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string, projectId: string) {
    const liveEnvironment = await getEnvironmentForOrganization(
      organizationSlug,
      LIVE_ENVIRONMENT
    );

    if (!liveEnvironment) {
      throw new Error("No live environment found");
    }

    const workflowsPresenter = new WorkflowsPresenter(this.#prismaClient);

    const workflows = await workflowsPresenter.data(
      {
        repositoryProject: {
          id: projectId,
        },
      },
      liveEnvironment.id
    );

    const deployments = await this.#prismaClient.projectDeployment.findMany({
      where: {
        projectId,
      },
      orderBy: {
        createdAt: "desc",
      },
      take: 3,
    });

    return {
      workflows,
      organizationSlug,
      deployments,
    };
  }
}
