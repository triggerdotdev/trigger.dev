import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class DeploymentPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string, projectId: string, deployId: string) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        id: deployId,
      },
    });

    if (!deployment) {
      throw new Error("Deployment not found");
    }

    const logType = ["STOPPED", "STOPPING", "DEPLOYED"].includes(
      deployment.status
    )
      ? "MACHINE"
      : "BUILD";

    const logs = await this.#prismaClient.deploymentLog.findMany({
      where: {
        deploymentId: deployId,
        logType: logType,
      },
      orderBy: [{ createdAt: "asc" }, { logNumber: "asc" }],
      take: 100,
    });

    return {
      organizationSlug,
      deployment,
      logs,
    };
  }
}
