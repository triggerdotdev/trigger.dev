import { type PrismaClient } from "@trigger.dev/database";
import { prisma } from "~/db.server";
import { DeleteEndpointService } from "./endpoints/deleteEndpointService";
import { logger } from "./logger.server";
import { DisableScheduleSourceService } from "./schedules/disableScheduleSource.server";

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
        environments: {
          include: {
            endpoints: true,
          },
        },
        jobs: {
          where: { deletedAt: null },
          include: {
            aliases: {
              where: {
                name: "latest",
              },
              include: {
                version: true,
              },
              take: 1,
            },
          },
        },
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

    //disable and delete all jobs
    const service = new DisableScheduleSourceService();
    for (const environment of project.environments) {
      //disable the event dispatchers
      await this.#prismaClient.eventDispatcher.updateMany({
        where: {
          environmentId: environment.id,
        },
        data: {
          enabled: false,
        },
      });
      const eventDispatchers = await this.#prismaClient.eventDispatcher.findMany({
        where: {
          environmentId: environment.id,
        },
      });

      logger.info("Deleting jobs", { jobs: project.jobs });
      for (const job of project.jobs) {
        //disable all the job versions
        await this.#prismaClient.jobVersion.updateMany({
          where: {
            jobId: job.id,
          },
          data: {
            status: "DISABLED",
          },
        });

        await this.#prismaClient.job.update({
          where: {
            id: job.id,
          },
          data: {
            deletedAt: new Date(),
          },
        });

        //disable scheduled sources
        for (const eventDispatcher of eventDispatchers) {
          await service.call({
            key: job.id,
            dispatcher: eventDispatcher,
          });
        }
      }
    }

    //delete all endpoints
    const deleteEndpointService = new DeleteEndpointService();
    for (const environment of project.environments) {
      for (const endpoint of environment.endpoints) {
        await deleteEndpointService.call(endpoint.id, options.userId);
      }
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
