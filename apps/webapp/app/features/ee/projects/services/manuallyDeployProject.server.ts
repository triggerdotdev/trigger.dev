import { LIVE_ENVIRONMENT } from "~/consts";
import { findProjectById } from "~/features/ee/projects/models/repositoryProject.server";
import { projectLogger } from "~/services/logger";
import { getCommit } from "../github/githubApp.server";
import { refreshInstallationAccessToken } from "../github/refreshInstallationAccessToken.server";
import { CreateProjectDeployment } from "./createProjectDeployment.server";

export class ManuallyDeployProject {
  #createProjectDeployment = new CreateProjectDeployment();

  public async call(projectId: string) {
    const project = await findProjectById(projectId);

    if (!project) {
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

    const latestCommit = await getCommit(
      appAuthorization.installationAccessToken,
      project.name,
      project.branch
    );

    projectLogger.debug("Manually creating deployment for commit", {
      project,
      latestCommit,
    });

    return await this.#createProjectDeployment.call({
      project,
      environment,
      authorization: appAuthorization,
      commit: latestCommit,
    });
  }
}
