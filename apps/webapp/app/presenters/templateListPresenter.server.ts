import type { Template } from ".prisma/client";
import type { ServiceMetadata } from "@trigger.dev/integration-sdk";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getServiceMetadatas } from "~/models/integrations.server";
import { renderMarkdown } from "~/services/renderMarkdown.server";

export type TemplateListItem = Omit<Template, "services"> & {
  services: Array<ServiceMetadata>;
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

    const serviceMetadatas = await getServiceMetadatas(true);

    const templatesWithServiceMetadata = templates.map((template) => {
      const services = template.services.map((s) => serviceMetadatas[s]);

      return {
        ...template,
        docsHTML: renderMarkdown(template.markdownDocs),
        services,
      };
    });

    return { templates: templatesWithServiceMetadata };
  }
}
