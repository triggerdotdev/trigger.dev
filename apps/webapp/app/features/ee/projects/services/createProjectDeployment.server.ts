import type {
  RepositoryProject,
  RuntimeEnvironment,
  ProjectDeployment,
} from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { cakework } from "../cakework.server";
import type { GitHubAppAuthorizationWithValidToken } from "../github/refreshInstallationAccessToken.server";
import type { GitHubCommit } from "../github/githubApp.server";
import { getNextDeploymentVersion } from "../models/repositoryProject.server";
import { projectLogger } from "~/services/logger";

export type CreateProjectDeploymentOptions = {
  project: RepositoryProject;
  authorization: GitHubAppAuthorizationWithValidToken;
  environment: RuntimeEnvironment;
  commit: GitHubCommit;
};

export class CreateProjectDeployment {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(
    {
      project,
      environment,
      authorization,
      commit,
    }: CreateProjectDeploymentOptions,
    retryCount = 0
  ): Promise<ProjectDeployment | undefined> {
    const version = await getNextDeploymentVersion(project.id);

    const dockerfile = formatFileContents(`
      FROM node:18.15-bullseye-slim
      LABEL "org.opencontainers.image.source"="${project.url}"
      LABEL "org.opencontainers.image.revision"="${commit.sha}"
      LABEL "org.opencontainers.image.created"="${new Date().toISOString()}"
      LABEL "org.opencontainers.image.version"="${version}"
      WORKDIR /app
      COPY package*.json ./
      RUN ${project.buildCommand}
      ENV NODE_ENV=production
      USER node
      COPY --chown=node:node . .
      CMD [${project.startCommand
        .split(" ")
        .map((s) => `"${s}"`)
        .join(", ")}]
    `);

    const dockerIgnore = formatFileContents(`
      node_modules
      render.yaml
    `);

    try {
      projectLogger.debug("Starting to build image from github", {
        dockerfile,
        dockerignore: dockerIgnore,
        token: authorization.installationAccessToken,
        project,
        retryCount,
        version,
      });

      const build = await cakework.buildImageFromGithub({
        dockerfile: dockerfile,
        dockerignore: dockerIgnore,
        token: authorization.installationAccessToken,
        repository: project.name,
        branch: project.branch,
      });

      projectLogger.debug("Build started from github", {
        dockerfile,
        dockerignore: dockerIgnore,
        token: authorization.installationAccessToken,
        project,
        retryCount,
        version,
        build,
      });
      // Create the deployment
      // Setting the buildStartAt because even though this is a PENDING deployment,
      // we have already started to build it with Cakework (it can still end up not getting deployed if this deployment is cancelled)
      const deployment = await this.#prismaClient.projectDeployment.create({
        data: {
          version,
          buildId: build.buildId,
          buildStartedAt: new Date(),
          project: {
            connect: {
              id: project.id,
            },
          },
          environment: {
            connect: {
              id: environment.id,
            },
          },
          status: "PENDING",
          branch: project.branch,
          commitHash: commit.sha,
          commitMessage: commit.commit.message,
          committer: getCommitAuthor(commit),
          dockerfile,
          dockerIgnore,
        },
      });

      projectLogger.debug("deployment created", {
        project,
        retryCount,
        version,
        build,
        deployment,
      });

      // TODO: implement this with workerQueue
      // await taskQueue.publish("PROJECT_DEPLOYMENT_CREATED", {
      //   id: deployment.id,
      // });

      return deployment;
    } catch (error) {
      projectLogger.debug("error creating deployment", {
        project,
        retryCount,
        version,
        error,
      });

      if (typeof error === "object" && error !== null) {
        if ("code" in error && error.code === "P2002") {
          if (retryCount > 3) {
            return;
          }
          // If the deployment version already exists, then we should retry
          return await this.call(
            {
              project,
              environment,
              authorization,
              commit,
            },
            retryCount + 1
          );
        }
      }

      throw error;
    }
  }
}

function getCommitAuthor(commit: GitHubCommit) {
  if (commit.commit.author && commit.commit.author.name) {
    return commit.commit.author.name;
  }

  if (commit.committer && commit.committer.login) {
    return commit.committer.login;
  }

  if (commit.author && commit.author.login) {
    return commit.author.login;
  }

  return "Unknown";
}

// Remove newlines at the beginning of the file, and remove any leading whitespace on each line (make sure not to remove any other whitespace)
// For example, the following input:
//
//      FROM node:bullseye-slim
//      WORKDIR /app
//      COPY package*.json ./
//      RUN npm install && npm run build
//      COPY . .
//      CMD ["node", "dist/index.js"]
//
// Would be formatted to:
// FROM node:bullseye-slim
// WORKDIR /app
// COPY package*.json ./
// RUN npm install && npm run build
// COPY . .
// CMD ["node", "dist/index.js"]
function formatFileContents(contents: string) {
  return contents
    .trimStart()
    .split("\n")
    .map((line) => line.trimStart())
    .join("\n");
}
