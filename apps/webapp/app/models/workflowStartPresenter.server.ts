import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { renderMarkdown } from "~/services/renderMarkdown.server";
import { getServiceMetadatas } from "./integrations.server";
import type { TemplateListItem } from "./templateListPresenter.server";

export class WorkflowStartPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({
    organizationSlug,
    userId,
    templateId,
  }: {
    organizationSlug: string;
    userId: string;
    templateId?: string;
  }) {
    const appAuthorizations =
      await this.#prismaClient.gitHubAppAuthorization.findMany({
        where: {
          organization: {
            slug: organizationSlug,
          },
          user: {
            id: userId,
          },
        },
        select: {
          id: true,
          accountName: true,
          installationId: true,
          permissions: true,
          repositorySelection: true,
        },
      });

    const template = await this.#getTemplate(templateId);

    const templates = await this.#prismaClient.template.findMany({
      orderBy: {
        priority: "asc",
      },
    });

    return {
      appAuthorizations,
      templates,
      template,
    };
  }

  async #getTemplate(
    templateId: string | undefined
  ): Promise<TemplateListItem | undefined> {
    if (!templateId) {
      return;
    }

    const template = await this.#prismaClient.template.findUnique({
      where: {
        id: templateId,
      },
    });

    if (!template) {
      return;
    }

    const serviceMetadatas = await getServiceMetadatas(true);

    return {
      ...template,
      services: template.services.map((s) => serviceMetadatas[s]),
      docsHTML: renderMarkdown(template.markdownDocs),
    };
  }
}
