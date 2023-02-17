import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getOauthOctokitRest } from "~/services/github/githubApp.server";
import { appEventPublisher } from "../messageBroker.server";
import fs from "node:fs/promises";
import tar from "tar";
import path from "node:path";
import os from "node:os";
import { RefreshAppAuthorizationService } from "./refreshAppAuthorization.server";

export class GithubRepositoryCreated {
  #prismaClient: PrismaClient;
  #refreshAppAuthorizationService: RefreshAppAuthorizationService =
    new RefreshAppAuthorizationService();

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: number) {
    const organizationTemplate =
      await this.#prismaClient.organizationTemplate.findUnique({
        where: {
          repositoryId: id,
        },
        include: {
          authorization: true,
          template: true,
        },
      });

    if (!organizationTemplate) {
      return;
    }

    const appAuthorization = await this.#refreshAppAuthorizationService.call(
      organizationTemplate.authorization
    );

    const octokit = await getOauthOctokitRest({
      token: appAuthorization.token,
      refreshToken: appAuthorization.refreshToken,
      expiresAt: appAuthorization.tokenExpiresAt.toISOString(),
      refreshTokenExpiresAt:
        appAuthorization.refreshTokenExpiresAt.toISOString(),
    });

    const sourceRepositoryUrl = new URL(
      organizationTemplate.template.repositoryUrl
    );
    const targetRepositoryUrl = new URL(organizationTemplate.repositoryUrl);

    // Get the owner and repo from the url, e.g. https://github.com/triggerdotdev/basic-starter -> triggerdotdev is the owner and basic-starter is the repo
    const [targetOwner, targetRepo] = targetRepositoryUrl.pathname
      .split("/")
      .slice(1);

    const [sourceOwner, sourceRepo] = sourceRepositoryUrl.pathname
      .split("/")
      .slice(1);

    // Get the latest commit hash to main
    const sourceBranchMain = await octokit.repos.getBranch({
      owner: sourceOwner,
      repo: sourceRepo,
      branch: "main",
    });

    if (!sourceBranchMain.data) {
      return;
    }

    const sourceArchiveLink = await octokit.repos.downloadTarballArchive({
      owner: sourceOwner,
      repo: sourceRepo,
      ref: "main",
    });

    // Download the source repository as a tarball
    const sourceArchive = await fetch(sourceArchiveLink.url);

    // Extract the tarball
    const sourceArchiveBuffer = await sourceArchive.arrayBuffer();

    // Create temporary directory and write the tarball to it
    const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "trigger-"));

    const tarballPath = `${tempDir}/source.tar.gz`;

    await fs.writeFile(tarballPath, Buffer.from(sourceArchiveBuffer));

    const destinationPath = await fs.mkdtemp(
      path.join(os.tmpdir(), "triggerd-")
    );

    // Extract the files
    await tar.extract({
      file: tarballPath,
      cwd: destinationPath,
    });

    // The root of the extracted tarball is destinationPath/sourceOwner-sourceRepo-<first 7 characters of the commit hash>
    const destinationRepoPath = path.join(
      destinationPath,
      `${sourceOwner}-${sourceRepo}-${sourceBranchMain.data.commit.sha.slice(
        0,
        7
      )}`
    );

    // Read the files from the extracted tarball
    const entries = await readDirectoryRecursively(destinationRepoPath);

    const commitFiles = entries.map((entry) => {
      const relativePath = path.relative(destinationRepoPath, entry.filePath);

      if (relativePath === "README.md") {
        // Replace all occurrences of the template repository url with the new repository url
        const readmeContent = replaceReadmeContents(
          organizationTemplate.repositoryUrl,
          organizationTemplate.template.repositoryUrl,
          organizationTemplate.name,
          organizationTemplate.template.slug,
          entry.fileContents
        );

        return {
          path: relativePath,
          content: readmeContent,
          mode: "100644" as const,
          type: "commit" as const,
        };
      }

      return {
        path: path.relative(destinationRepoPath, entry.filePath),
        content: entry.fileContents,
        mode: "100644" as const,
        type: "commit" as const,
      };
    });

    // Get the latest commit hash to main
    const targetBranchMain = await octokit.repos.getBranch({
      owner: targetOwner,
      repo: targetRepo,
      branch: "main",
    });

    // Create a tree with the files
    const tree = await octokit.git.createTree({
      owner: targetOwner,
      repo: targetRepo,
      tree: commitFiles,
      base_tree: targetBranchMain.data.commit.sha,
    });

    // Create the commit
    const commit = await octokit.git.createCommit({
      owner: targetOwner,
      repo: targetRepo,
      message: "Initial commit",
      tree: tree.data.sha,
      parents: [],
    });

    // Update the ref to point to the new commit
    await octokit.git.updateRef({
      owner: targetOwner,
      repo: targetRepo,
      ref: "heads/main",
      sha: commit.data.sha,
      force: true,
    });

    await this.#prismaClient.organizationTemplate.update({
      where: {
        id: organizationTemplate.id,
      },
      data: {
        status: "READY_TO_DEPLOY",
      },
    });

    await appEventPublisher.publish(
      "organization-template.updated",
      {
        id: organizationTemplate.id,
        status: "READY_TO_DEPLOY",
      },
      {
        "x-organization-template-id": organizationTemplate.id,
      }
    );
  }
}

async function readDirectoryRecursively(
  directoryPath: string
): Promise<{ filePath: string; fileContents: string }[]> {
  const result: { filePath: string; fileContents: string }[] = [];

  // Read the contents of the directory
  const files = await fs.readdir(directoryPath, {
    withFileTypes: true,
  });

  // Iterate over the files and subdirectories in the directory
  for (const file of files) {
    const filePath = path.join(directoryPath, file.name);

    // If the item is a file, read its contents and add to the result array
    if (file.isFile()) {
      const fileContents = await fs.readFile(filePath, "utf8");
      result.push({ filePath, fileContents });
    }

    // If the item is a directory, recursively read its contents and add to the result array
    if (file.isDirectory()) {
      const directoryContents = await readDirectoryRecursively(filePath);
      result.push(...directoryContents);
    }
  }

  return result;
}

function replaceReadmeContents(
  finalRepoUrl: string,
  templateRepoUrl: string,
  finalRepoName: string,
  templateRepoName: string,
  readme: string
) {
  // Replace all instances (not just the first) of the templateRepoUrl with the finalRepoUrl
  const finalRepoUrlRegex = new RegExp(templateRepoUrl, "g");
  let finalDocs = readme.replace(finalRepoUrlRegex, finalRepoUrl);

  // Replace all instances (not just the first) of the templateRepoName with the finalRepoName
  const finalRepoNameRegex = new RegExp(`cd ${templateRepoName}`, "g");
  finalDocs = finalDocs.replace(finalRepoNameRegex, `cd ${finalRepoName}`);

  return finalDocs;
}
