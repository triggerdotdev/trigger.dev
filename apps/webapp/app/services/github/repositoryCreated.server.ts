import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getOctokitRest } from "~/services/github/githubApp.server";
import { appEventPublisher } from "../messageBroker.server";

export class GithubRepositoryCreated {
  #prismaClient: PrismaClient;

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

    const octokit = await getOctokitRest(
      organizationTemplate.authorization.installationId
    );

    const repositoryUrl = new URL(organizationTemplate.repositoryUrl);

    // Get the owner and repo from the url, e.g. https://github.com/triggerdotdev/basic-starter -> triggerdotdev is the owner and basic-starter is the repo
    const [owner, repo] = repositoryUrl.pathname.split("/").slice(1);

    // Update the readme with the new repository url, by replacing the template url with the new repository url
    const readme = await octokit.repos.getReadme({
      owner,
      repo,
    });

    // readme.data.content is base64 encoded, so we need to decode it first
    const decodedContent = Buffer.from(readme.data.content, "base64").toString(
      "utf-8"
    );

    const readmeContent = decodedContent.replace(
      organizationTemplate.template.repositoryUrl,
      organizationTemplate.repositoryUrl
    );

    await octokit.repos.createOrUpdateFileContents({
      owner,
      repo,
      path: "README.md",
      message: "Update README.md",
      content: Buffer.from(readmeContent).toString("base64"),
      sha: readme.data.sha,
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
