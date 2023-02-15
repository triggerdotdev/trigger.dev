import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getIntegrationMetadataByService } from "~/models/integrations.server";
import { renderMarkdown } from "~/services/renderMarkdown.server";
import { TemplateListItem } from "./templateListPresenter.server";

export class TemplatePresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(
    slug: string
  ): Promise<{ template: TemplateListItem | undefined }> {
    const template = await this.#prismaClient.template.findUnique({
      where: {
        slug,
      },
    });

    if (!template) {
      return { template: undefined };
    }

    const templateWithServiceMetadata = {
      ...template,
      docsHTML: renderMarkdown(template.markdownDocs),
      services: template.services.map(getIntegrationMetadataByService),
    };

    return { template: templateWithServiceMetadata };
  }
}
