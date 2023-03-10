import { LIVE_ENVIRONMENT } from "~/consts";
import { findProjectByRepo } from "~/features/ee/projects/models/repositoryProject.server";
import { getCommit } from "../github/githubApp.server";
import { refreshInstallationAccessToken } from "../github/refreshInstallationAccessToken.server";
import { CreateProjectDeployment } from "./createProjectDeployment.server";

export class ReceiveRepositoryPush {
  #createProjectDeployment = new CreateProjectDeployment();

  public async call(data: {
    branch: string;
    commitSha: string;
    repository: string;
  }) {
    console.log(
      `Received push for ${data.repository} on ${data.branch}: ${data.commitSha}`
    );

    const project = await findProjectByRepo(data.repository);

    if (!project) {
      return;
    }

    if (project.branch !== data.branch) {
      return;
    }

    if (!project.autoDeploy) {
      return;
    }

    const environment = project.organization.environments.find(
      (environment) => environment.slug === LIVE_ENVIRONMENT
    );

    if (!environment) {
      return;
    }

    // Retrieve the latest commit from the "main" branch in the repo
    const appAuthorization = await refreshInstallationAccessToken(
      project.authorizationId
    );

    const commit = await getCommit(
      appAuthorization.installationAccessToken,
      project.name,
      data.commitSha
    );

    console.log(`Received commit for ${project.name}: ${commit.sha}`);

    await this.#createProjectDeployment.call({
      project,
      environment,
      authorization: appAuthorization,
      commit,
    });
  }
}
