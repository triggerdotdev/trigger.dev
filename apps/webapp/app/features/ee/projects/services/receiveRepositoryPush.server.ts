import { LIVE_ENVIRONMENT } from "~/consts";
import { prisma, PrismaClient } from "~/db.server";
import {
  findProjectByRepo,
  repositoryCanDeploy,
} from "~/features/ee/projects/models/repositoryProject.server";
import { projectLogger } from "~/services/logger";
import { getCommit } from "../github/githubApp.server";
import { refreshInstallationAccessToken } from "../github/refreshInstallationAccessToken.server";
import { CreateProjectDeployment } from "./createProjectDeployment.server";

export class ReceiveRepositoryPush {
  #prismaClient: PrismaClient;
  #createProjectDeployment = new CreateProjectDeployment();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(data: {
    branch: string;
    commitSha: string;
    repository: string;
  }) {
    const project = await findProjectByRepo(data.repository);

    if (!project) {
      return;
    }

    if (project.branch !== data.branch) {
      return;
    }

    projectLogger.debug("Received push for project", { project, data });

    // Retrieve the latest commit from the "main" branch in the repo
    const appAuthorization = await refreshInstallationAccessToken(
      project.authorizationId
    );

    const commit = await getCommit(
      appAuthorization.installationAccessToken,
      project.name,
      data.commitSha
    );

    projectLogger.debug("Received commit for project", { project, commit });

    await this.#prismaClient.repositoryProject.update({
      where: { id: project.id },
      data: {
        latestCommit: commit,
      },
    });

    if (!project.autoDeploy) {
      return;
    }

    const environment = project.organization.environments.find(
      (environment) => environment.slug === LIVE_ENVIRONMENT
    );

    if (!environment) {
      return;
    }

    if (!repositoryCanDeploy(project)) {
      return;
    }

    await this.#createProjectDeployment.call({
      project,
      environment,
      authorization: appAuthorization,
      commit,
    });
  }
}
