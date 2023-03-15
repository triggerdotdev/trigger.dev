import { prisma, PrismaClient } from "~/db.server";
import { projectLogger } from "~/services/logger";
import { taskQueue } from "~/services/messageBroker.server";

export class CleanupProject {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(projectId: string) {
    // Deployments with a vmIdentifier and NOT STOPPED should be stopped
    const deployments = await this.#prismaClient.projectDeployment.findMany({
      where: {
        projectId,
        vmIdentifier: {
          not: null,
        },
        status: {
          notIn: ["STOPPED"],
        },
      },
    });

    projectLogger.debug("Stopping VMs", { deployments });

    for (const deployment of deployments) {
      if (deployment.vmIdentifier) {
        await taskQueue.publish("STOP_VM", {
          id: deployment.vmIdentifier,
        });
      }
    }

    // PENDING deployments should be cancelled
    // BUILDING deployments should be stopped
    // DEPLOYING deployments should be stopped
    // DEPLOYED deployments should be stopped
    // STOPPING deployments should be stopped
    // ERROR deployments should be ignored
    // STOPPED deployments should be ignored
    // CANCELLED deployments should be ignored

    await this.#prismaClient.projectDeployment.updateMany({
      where: {
        projectId,
        status: {
          in: ["BUILDING", "DEPLOYING", "DEPLOYED", "STOPPING"],
        },
      },
      data: {
        status: "STOPPED",
        stoppedAt: new Date(),
      },
    });

    await this.#prismaClient.projectDeployment.updateMany({
      where: {
        projectId,
        status: {
          in: ["PENDING"],
        },
      },
      data: {
        status: "CANCELLED",
      },
    });

    // Delete all deployment logs for this project that are older than 1 day
    await this.#prismaClient.deploymentLog.deleteMany({
      where: {
        deployment: {
          projectId,
        },
        createdAt: {
          lt: new Date(Date.now() - 1000 * 60 * 60 * 24),
        },
      },
    });
  }
}
