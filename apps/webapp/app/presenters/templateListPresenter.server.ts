import type { Template } from ".prisma/client";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { renderMarkdown } from "~/services/renderMarkdown.server";

export type TemplateListItem = Omit<Template, "services"> & {
  services: Array<any>;
  docsHTML: string;
};

export class TemplateListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(): Promise<{ templates: Array<TemplateListItem> }> {
    const templates = await this.#prismaClient.template.findMany({
      orderBy: { priority: "asc" },
      where: { isLive: true },
    });

    const templatesWithServiceMetadata = templates.map((template) => {
      return {
        ...template,
        docsHTML: renderMarkdown(template.markdownDocs),
        services: [],
      };
    });

    return { templates: templatesWithServiceMetadata };
  }
}
