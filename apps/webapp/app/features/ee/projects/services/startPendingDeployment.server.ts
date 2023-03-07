import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { StartDeployment } from "./startDeployment.server";

export class StartPendingDeployment {
  #prismaClient: PrismaClient;
  #startDeployment = new StartDeployment();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async call(id: string) {
    const project = await this.#prismaClient.repositoryProject.findUnique({
      where: {
        id,
      },
    });

    if (!project) {
      return;
    }

    if (project.status !== "DEPLOYED") {
      return;
    }

    // Find latest pending deployment with an imageIdentifier
    const deployment = await this.#prismaClient.projectDeployment.findFirst({
      where: {
        projectId: project.id,
        status: "PENDING",
        imageId: {
          not: null,
        },
      },
      orderBy: {
        createdAt: "desc",
      },
      include: {
        environment: true,
      },
    });

    if (!deployment) {
      return;
    }

    return await this.#startDeployment.call({
      deployment,
      project,
      environment: deployment.environment,
    });
  }
}
