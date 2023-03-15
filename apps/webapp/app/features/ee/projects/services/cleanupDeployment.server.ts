import { CakeworkApiError } from "@cakework/client/dist";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { projectLogger } from "~/services/logger";
import { cakework } from "../cakework.server";

export class CleanupDeployment {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        id,
      },
      include: {
        project: true,
      },
    });

    if (!deployment) {
      return true;
    }

    if (deployment.status !== "DEPLOYED") {
      return true;
    }

    if (deployment.project.currentDeploymentId === id) {
      return true;
    }

    if (!deployment.vmIdentifier) {
      return true;
    }

    try {
      projectLogger.debug("Stopping VM for deployment", { deployment });

      await this.#prismaClient.projectDeployment.update({
        where: {
          id,
        },
        data: {
          status: "STOPPING",
          stoppedAt: new Date(),
        },
      });

      await this.#prismaClient.repositoryProject.update({
        where: {
          id: deployment.projectId,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      await cakework.stopVm(deployment.vmIdentifier);

      projectLogger.debug("Stopped VM for deployment", { deployment });

      await this.#prismaClient.projectDeployment.update({
        where: {
          id,
        },
        data: {
          status: "STOPPED",
          stoppedAt: new Date(),
        },
      });

      await this.#prismaClient.repositoryProject.update({
        where: {
          id: deployment.projectId,
        },
        data: {
          updatedAt: new Date(),
        },
      });

      return true;
    } catch (error) {
      if (error instanceof CakeworkApiError) {
        projectLogger.debug("Error Stopping VM for deployment", {
          deployment,
          error,
        });

        return false;
      }

      throw error;
    }
  }
}
