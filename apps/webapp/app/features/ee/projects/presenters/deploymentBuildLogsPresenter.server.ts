import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class DeploymentBuildLogsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(deployId: string) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        id: deployId,
      },
    });

    if (!deployment) {
      throw new Error("Deployment not found");
    }

    const logs = await this.#prismaClient.deploymentLog.findMany({
      where: {
        deploymentId: deployId,
        logType: "BUILD",
      },
      orderBy: [{ createdAt: "asc" }, { logNumber: "asc" }],
      take: 1000,
    });

    return {
      deployment,
      logs,
    };
  }
}
