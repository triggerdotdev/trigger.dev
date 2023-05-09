import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { statusTextForBuilding } from "~/features/ee/projects/models/repositoryProject.server";
import { projectLogger } from "~/services/logger";

export class DeploymentCreated {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const deployment = await this.#prismaClient.projectDeployment.findUnique({
      where: {
        id,
      },
      include: {
        project: true,
      },
    });

    if (!deployment) {
      return;
    }

    // If the RepositoryProjec status is:
    // - PENDING: Update the project to be building
    // - DEPLOYED: Update the project to be building
    // - PREPARING: Update the project to be building
    // - BUILDING: Do nothing
    // - ERROR: Update the project to be building
    // - DISABLED: Do nothing
    // - DEPLOYING: Do nothing

    switch (deployment.project.status) {
      case "PENDING":
      case "DEPLOYED":
      case "PREPARING":
      case "ERROR": {
        // Set the project as "building"
        // will transition to "deploying" when the build is complete (see: buildComplete.server.ts)
        projectLogger.debug(`Setting project to BUILDING`, { deployment });

        await this.#prismaClient.repositoryProject.update({
          where: {
            id: deployment.project.id,
          },
          data: {
            status: "BUILDING",
            statusText: statusTextForBuilding(deployment, deployment.project),
          },
        });

        await this.#prismaClient.projectDeployment.update({
          where: {
            id: deployment.id,
          },
          data: {
            status: "BUILDING",
          },
        });
      }
    }

    // Start polling for logs for this project deployment
    // TODO: implement this in the new worker
    // await taskQueue.publish("DEPLOYMENT_LOG_POLL", {
    //   id: deployment.id,
    //   count: 0,
    // });

    // We also need to check if there are any other PENDING deployments for this project
    // and if so we should cancel them (because we have a newer push)
    await this.#prismaClient.projectDeployment.updateMany({
      where: {
        projectId: deployment.project.id,
        status: "PENDING",
        id: {
          not: deployment.id,
        },
      },
      data: {
        status: "CANCELLED",
      },
    });
  }
}
