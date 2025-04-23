import { BackgroundWorkerTask } from "@trigger.dev/database";
import { PrismaClient, prisma } from "~/db.server";
import { Project } from "~/models/project.server";
import { User } from "~/models/user.server";

export class TaskPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    userId,
    taskFriendlyId,
    projectSlug,
  }: {
    userId: User["id"];
    taskFriendlyId: BackgroundWorkerTask["friendlyId"];
    projectSlug: Project["slug"];
  }) {
    const task = await this.#prismaClient.backgroundWorkerTask.findFirst({
      select: {
        id: true,
        slug: true,
        filePath: true,
        friendlyId: true,
        createdAt: true,
        worker: {
          select: {
            id: true,
            version: true,
            sdkVersion: true,
            cliVersion: true,
            createdAt: true,
            updatedAt: true,
            friendlyId: true,
          },
        },
        runtimeEnvironment: {
          select: {
            id: true,
            slug: true,
            type: true,
            orgMember: {
              select: {
                user: {
                  select: {
                    id: true,
                    name: true,
                    displayName: true,
                  },
                },
              },
            },
          },
        },
      },
      where: {
        friendlyId: taskFriendlyId,
        runtimeEnvironment: {
          organization: {
            members: {
              some: {
                userId,
              },
            },
          },
        },
        project: {
          slug: projectSlug,
        },
      },
    });

    if (!task) {
      return undefined;
    }

    return task;
  }
}
