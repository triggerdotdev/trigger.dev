import type {
  ProjectDeployment,
  RepositoryProject,
  RuntimeEnvironment,
} from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import {
  buildEnvVars,
  statusTextForDeployed,
  statusTextForDeploying,
} from "~/features/ee/projects/models/repositoryProject.server";
import { projectLogger } from "~/services/logger";
import { cakework } from "../cakework.server";

export type StartDeploymentOptions = {
  deployment: ProjectDeployment;
  project: RepositoryProject;
  environment: RuntimeEnvironment;
};

export class StartDeployment {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call({
    deployment,
    project,
    environment,
  }: StartDeploymentOptions) {
    if (!deployment.imageId) {
      return true;
    }

    projectLogger.debug("Starting deployment", {
      deployment,
      project,
      environment,
    });

    // Update the project and deployment status to deploying
    await this.#prismaClient.repositoryProject.update({
      where: {
        id: project.id,
      },
      data: {
        status: "DEPLOYING",
        statusText: statusTextForDeploying(deployment, project),
      },
    });

    await this.#prismaClient.projectDeployment.update({
      where: {
        id: deployment.id,
      },
      data: {
        status: "DEPLOYING",
      },
    });

    const vmStart = performance.now();

    const envVars = buildEnvVars(deployment, project, environment);

    projectLogger.debug("Starting VM with env vars", { deployment, envVars });

    try {
      const vm = await cakework.startVm({
        imageId: deployment.imageId,
        cpu: 1,
        memory: 256,
        envVars,
      });

      const vmEnd = performance.now();

      projectLogger.debug("Started VM", {
        deployment,
        duration: vmEnd - vmStart,
        vm,
      });

      // Update the deployment with the VM
      await this.#prismaClient.projectDeployment.update({
        where: {
          id: deployment.id,
        },
        data: {
          vmIdentifier: vm.id,
          status: "DEPLOYED",
          buildFinishedAt: new Date(),
        },
      });

      // Update the project
      await this.#prismaClient.repositoryProject.update({
        where: {
          id: project.id,
        },
        data: {
          status: "DEPLOYED",
          currentDeploymentId: deployment.id,
          statusText: statusTextForDeployed(deployment, project),
        },
      });

      // If there are any pending deployments, we can start them now
      // await taskQueue.publish("DEPLOYMENT_DEPLOYED", {
      //   id: deployment.id,
      //   projectId: project.id,
      // });

      // Make sure to stop the previous deployment
      if (project.currentDeploymentId) {
        // await taskQueue.publish("CLEANUP_DEPLOYMENT", {
        //   id: project.currentDeploymentId,
        // });
      }
    } catch (error) {
      projectLogger.debug("Error Starting VM", { deployment, error });

      // Update the deployment to be errored
      await this.#prismaClient.projectDeployment.update({
        where: {
          id: deployment.id,
        },
        data: {
          status: "ERROR",
          error: JSON.parse(JSON.stringify(error)),
        },
      });

      // Update the project to be errored
      await this.#prismaClient.repositoryProject.update({
        where: {
          id: project.id,
        },
        data: {
          status: "ERROR",
          statusText: `Error building project: ${
            error instanceof Error ? error.message : error
          }`,
        },
      });

      return false;
    }

    return true;
  }
}
