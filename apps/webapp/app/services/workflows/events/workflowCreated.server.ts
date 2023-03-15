import { env } from "process";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestCustomEvent } from "~/services/events/ingestCustomEvent.server";
import { appEventPublisher } from "~/services/messageBroker.server";

export class WorkflowCreated {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(id: string) {
    const workflow = await this.#prismaClient.workflow.findUnique({
      where: { id },
    });

    if (!workflow) {
      return;
    }

    await this.#sendInternalEvent(workflow.id);
  }

  async #sendInternalEvent(id: string) {
    if (!env.INTERNAL_TRIGGER_API_KEY) {
      return true;
    }

    const ingestEventService = new IngestCustomEvent();

    await ingestEventService.call({
      id,
      event: { name: "workflow.created", payload: { id: id } },
      apiKey: env.INTERNAL_TRIGGER_API_KEY,
    });
  }
}
