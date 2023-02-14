import { Template } from ".prisma/client";
import type { IntegrationMetadata } from "@trigger.dev/integration-sdk";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getIntegrationMetadataByService } from "~/models/integrations.server";

export type TemplateListItem = Omit<Template, "services"> & {
  services: Array<IntegrationMetadata>;
};

export class TemplateListPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data(): Promise<{ templates: Array<TemplateListItem> }> {
    const templates = await this.#prismaClient.template.findMany({
      orderBy: { priority: "asc" },
    });

    const templatesWithServiceMetadata = templates.map((template) => {
      const services = template.services.map(getIntegrationMetadataByService);

      return {
        ...template,
        services,
      };
    });

    return { templates: templatesWithServiceMetadata };
  }
}
