import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { workerQueue } from "~/services/worker.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return json({ error: "Invalid or Missing eventId" }, { status: 400 });
  }

  const { eventId } = parsed.data;

  const event = await prisma.eventRecord.findFirst({
    select: {
      id: true,
      name: true,
      createdAt: true,
      updatedAt: true,
      environmentId: true,
      runs: {
        select: {
          id: true,
          status: true,
          startedAt: true,
          completedAt: true,
        },
      },
    },
    where: {
      id: eventId,
      environmentId: authenticatedEnv.id,
    },
  });
  if (!event) {
    return json({ error: "Event not found" }, { status: 404 });
  }

//update the cancelledAt column in the eventRecord table
  const updatedEvent = await prisma.eventRecord.update({
    where: { id: event.id },
    data: { cancelledAt: new Date() },
  });

  // Dequeue the event after the db has been updated
  await workerQueue.dequeue(event.id, { tx: prisma });

  return json(updatedEvent);
}
