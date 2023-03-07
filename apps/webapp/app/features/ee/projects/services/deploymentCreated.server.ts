import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { statusTextForBuilding } from "~/features/ee/projects/models/repositoryProject.server";

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
    // - BUILDING: Do nothing
    // - ERROR: Update the project to be building
    // - DISABLED: Do nothing
    // - DEPLOYING: Do nothing

    switch (deployment.project.status) {
      case "PENDING":
      case "DEPLOYED":
      case "ERROR": {
        // Set the project as "building"
        // will transition to "deploying" when the build is complete (see: buildComplete.server.ts)
        console.log(
          `Setting project ${deployment.project.id} and deployment ${deployment.id} to BUILDING`
        );

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
