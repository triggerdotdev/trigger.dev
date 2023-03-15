import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { projectLogger } from "~/services/logger";
import { taskQueue } from "~/services/messageBroker.server";

export class DisableProjectService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(projectId: string) {
    const project =
      await this.#prismaClient.repositoryProject.findUniqueOrThrow({
        where: {
          id: projectId,
        },
      });

    if (project.status !== "PENDING") {
      await taskQueue.publish("CLEANUP_PROJECT", {
        id: project.id,
      });
    }

    projectLogger.debug("Disabling project", { project });

    await this.#prismaClient.repositoryProject.update({
      where: {
        id: projectId,
      },
      data: {
        status: "DISABLED",
      },
    });

    return project;
  }
}
