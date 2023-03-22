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
    const workflowsPresenter = new WorkflowsPresenter(this.#prismaClient);

    const workflows = await workflowsPresenter.data({
      repositoryProject: {
        id: projectId,
      },
    });

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
