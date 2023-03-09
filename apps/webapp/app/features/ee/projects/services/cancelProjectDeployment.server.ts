import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class CancelProjectDeployment {
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

    if (deployment.status !== "PENDING") {
      return true;
    }

    await this.#prismaClient.projectDeployment.update({
      where: {
        id,
      },
      data: {
        status: "CANCELLED",
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
  }
}
