import { schemas } from "@trigger.dev/slack/internal";
import { ulid } from "ulid";
import { generateErrorMessage } from "zod-error";
import type { PrismaClient } from "~/db.server";
import { prisma } from "~/db.server";
import { IngestEvent } from "../events/ingest.server";

export class HandleSlackInteractivity {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  public async call(payload: unknown) {
    console.log("payload", JSON.stringify(payload, null, 2));

    const parsedPayload = schemas.blockAction.safeParse(payload);

    if (!parsedPayload.success) {
      console.error(
        "Invalid payload",
        generateErrorMessage(parsedPayload.error.issues)
      );

      return;
    }

    if (parsedPayload.data.type !== "block_actions") {
      return;
    }

    if (!parsedPayload.data.message) {
      return;
    }

    if (!parsedPayload.data.message.metadata) {
      return;
    }

    const { requestId } = parsedPayload.data.message.metadata.event_payload;

    const integrationRequest =
      await this.#prismaClient.integrationRequest.findUnique({
        where: { id: requestId },
        include: {
          run: {
            include: {
              environment: true,
              workflow: true,
            },
          },
        },
      });

    if (!integrationRequest) {
      return;
    }

    const ingestService = new IngestEvent();

    await ingestService.call({
      id: ulid(),
      type: "SLACK_INTERACTION",
      name: "block.action",
      service: "slack",
      payload: parsedPayload.data,
      apiKey: integrationRequest.run.environment.apiKey,
    });

    return true;
  }
}
