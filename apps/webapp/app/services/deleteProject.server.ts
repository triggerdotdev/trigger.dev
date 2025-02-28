import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { logger } from "./logger.server";

type Options = ({ projectId: string } | { projectSlug: string }) & {
  userId: string;
};

export class DeleteProjectService {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(options: Options) {
    const projectId = await this.#getProjectId(options);
    const project = await this.#prismaClient.project.findFirst({
      include: {
        environments: true,
        organization: true,
      },
      where: {
        id: projectId,
        organization: { members: { some: { userId: options.userId } } },
      },
    });

    if (!project) {
      throw new Error("Project not found");
    }

    if (project.deletedAt) {
      return;
    }

    //mark the project as deleted
    await this.#prismaClient.project.update({
      where: {
        id: project.id,
      },
      data: {
        deletedAt: new Date(),
      },
    });
  }

  async #getProjectId(options: Options) {
    if ("projectId" in options) {
      return options.projectId;
    }

    const { id } = await this.#prismaClient.project.findFirstOrThrow({
      select: {
        id: true,
      },
      where: {
        slug: options.projectSlug,
      },
    });

    return id;
  }
}
