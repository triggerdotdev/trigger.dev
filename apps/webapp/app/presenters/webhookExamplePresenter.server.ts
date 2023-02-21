import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { getVersion1Integrations } from "~/models/integrations.server";

export class WebhookExamplesPresenter {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  async data({ service, name }: { service: string; name: string }) {
    const v1Services = getVersion1Integrations(true);
    const v1Service = v1Services.find((s) => s.metadata.service === service);

    if (!v1Service) {
      return {};
    }

    const example = v1Service.webhooks?.examples(name);
    return example?.payload ?? {};
  }
}
