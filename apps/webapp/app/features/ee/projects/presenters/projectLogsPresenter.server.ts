import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";

export class ProjectLogsPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(organizationSlug: string, projectId: string) {
    const { currentDeployment } =
      await this.#prismaClient.repositoryProject.findUniqueOrThrow({
        where: {
          id: projectId,
        },
        include: {
          currentDeployment: {
            include: {
              logs: {
                where: {
                  logType: "MACHINE",
                },
                orderBy: [{ createdAt: "asc" }, { logNumber: "asc" }],
                take: 100,
              },
            },
          },
        },
      });

    return {
      currentDeployment,
      logs: currentDeployment?.logs ?? [],
    };
  }
}
