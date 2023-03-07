import { LIVE_ENVIRONMENT } from "~/consts";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getEnvironmentForOrganization } from "~/models/runtimeEnvironment.server";
import { WorkflowsPresenter } from "~/presenters/workflowsPresenter.server";

export class DeploymentListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string, projectId: string) {
    const deployments = await this.#prismaClient.projectDeployment.findMany({
      where: {
        projectId,
      },
      orderBy: {
        version: "desc",
      },
      take: 30,
    });

    return {
      organizationSlug,
      deployments,
    };
  }
}
