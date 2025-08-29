import { PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { marqs } from "~/v3/marqs/index.server";
import { engine } from "~/v3/runEngine.server";

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

    // Remove queues from MARQS
    for (const environment of project.environments) {
      await marqs?.removeEnvironmentQueuesFromMasterQueue(project.organization.id, environment.id);
    }

    // Delete all queues from the RunEngine 2 prod master queues
    for (const environment of project.environments) {
      await engine.removeEnvironmentQueuesFromMasterQueue({
        runtimeEnvironmentId: environment.id,
        organizationId: project.organization.id,
        projectId: project.id,
      });
    }

    // Mark the project as deleted (do this last because it makes it impossible to try again)
    // - This disables all API keys
    // - This disables all schedules from being scheduled
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
