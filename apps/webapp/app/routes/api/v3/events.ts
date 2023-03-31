import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { generateErrorMessage } from "zod-error";
import type { PrismaClient } from "~/db.server";
import { PrismaErrorSchema } from "~/db.server";
import type { RawEvent, SendEventOptions } from "@trigger.dev/internal";
import { SendEventBodySchema } from "@trigger.dev/internal";
import type { Organization, RuntimeEnvironment } from ".prisma/client";
import { prisma } from "~/db.server";
import { workerQueue } from "~/services/worker.server";

export async function action({ request }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  // Now parse the request body
  const anyBody = await request.json();

  const body = SendEventBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json(
      { message: generateErrorMessage(body.error.issues) },
      { status: 422 }
    );
  }

  const service = new IngestSendEvent();

  const event = await service.call(
    authenticatedEnv,
    authenticatedEnv.organization,
    body.data.event,
    body.data.options
  );

  return json(event);
}

export class IngestSendEvent {
  #prismaClient: PrismaClient;

  constructor(prismaClient: PrismaClient = prisma) {
    this.#prismaClient = prismaClient;
  }

  #calculateDeliverAt(options?: SendEventOptions) {
    // If deliverAt is a string and a valid date, convert it to a Date object
    if (options?.deliverAt && typeof options.deliverAt === "string") {
      const deliverAt = new Date(options.deliverAt);

      if (deliverAt.toString() !== "Invalid Date") {
        return deliverAt;
      }
    }

    // deliverAfter is the number of seconds to wait before delivering the event
    if (options?.deliverAfter) {
      return new Date(Date.now() + options.deliverAfter * 1000);
    }

    return undefined;
  }

  public async call(
    environment: RuntimeEnvironment,
    organization: Organization,
    event: RawEvent,
    options?: SendEventOptions
  ) {
    try {
      const deliverAt = this.#calculateDeliverAt(options);
      // Create a new event in the database
      const eventLog = await this.#prismaClient.eventLog.create({
        data: {
          organization: {
            connect: {
              id: organization.id,
            },
          },
          environment: {
            connect: {
              id: environment.id,
            },
          },
          id: event.id,
          name: event.name,
          timestamp: event.timestamp ?? new Date(),
          payload: event.payload ?? {},
          context: event.context ?? {},
          source: event.source,
          deliverAt: deliverAt,
        },
      });

      // Produce a message to the event bus
      await workerQueue.enqueue(
        "deliverEvent",
        {
          id: eventLog.id,
        },
        { runAt: eventLog.deliverAt }
      );

      return eventLog;
    } catch (error) {
      const prismaError = PrismaErrorSchema.safeParse(error);
      // If the error is a Prisma unique constraint error, it means that the event already exists
      if (prismaError.success && prismaError.data.code === "P2002") {
        return this.#prismaClient.eventLog.findUniqueOrThrow({
          where: {
            id: event.id,
          },
        });
      }

      throw error;
    }
  }
}
