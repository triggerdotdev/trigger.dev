import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getIntegrationMetadataByService } from "~/models/integrations.server";
import { getRuntimeEnvironment } from "~/models/runtimeEnvironment.server";
import { renderMarkdown } from "~/services/renderMarkdown.server";
import { TemplateListItem } from "./templateListPresenter.server";
import { WorkflowsPresenter } from "./workflowsPresenter.server";

export class OrganizationTemplatePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(templateId: string, environmentSlug: string) {
    const organizationTemplate =
      await this.#prismaClient.organizationTemplate.findUnique({
        where: {
          id: templateId,
        },
        include: {
          template: true,
          authorization: true,
        },
      });

    if (!organizationTemplate) {
      throw new Error("Organization template not found");
    }

    const runtimeEnvironment = await getRuntimeEnvironment({
      organizationId: organizationTemplate.organizationId,
      slug: environmentSlug,
    });

    if (!runtimeEnvironment) {
      throw new Error("Runtime environment not found");
    }

    const workflowsPresenter = new WorkflowsPresenter(this.#prismaClient);

    const workflows = await workflowsPresenter.data(
      {
        organizationId: organizationTemplate.organizationId,
        slug: {
          in: organizationTemplate.template.workflowIds,
        },
      },
      runtimeEnvironment.id
    );

    const repositoryName =
      organizationTemplate.repositoryUrl.split("/").pop() ??
      "missing repository name";

    const template: TemplateListItem = {
      ...organizationTemplate.template,
      services: organizationTemplate.template.services.map(
        getIntegrationMetadataByService
      ),
      docsHTML: renderMarkdown(organizationTemplate.template.markdownDocs),
    };

    return {
      template,
      organizationTemplate,
      apiKey: runtimeEnvironment.apiKey,
      workflows,
      runLocalDocsHTML: renderLocalDocsHTML(
        organizationTemplate.repositoryUrl,
        organizationTemplate.template.repositoryUrl,
        runtimeEnvironment.apiKey,
        organizationTemplate.template.runLocalDocs
      ),
      repositoryName,
    };
  }
}

// Replace the templateRepoUrl in localDocs with the finalRepoUrl, and then renderMarkdown
function renderLocalDocsHTML(
  finalRepoUrl: string,
  templateRepoUrl: string,
  apiKey: string,
  localDocs: string
) {
  const localDocsWithFinalRepoUrl = localDocs
    .replace(templateRepoUrl, finalRepoUrl)
    .replace("<APIKEY>", apiKey)
    .replace("<API_KEY>", apiKey)
    .replace("<your api key>", apiKey);

  return renderMarkdown(localDocsWithFinalRepoUrl);
}
