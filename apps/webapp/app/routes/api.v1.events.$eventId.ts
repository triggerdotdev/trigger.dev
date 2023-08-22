import type { LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { GetEvent } from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { apiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(request, json({}));
  }

  const authenticationResult = await authenticateApiRequest(request, {
    allowPublicKey: true,
  });
  if (!authenticationResult) {
    return apiCors(request, json({ error: "Invalid or Missing API key" }, { status: 401 }));
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return apiCors(request, json({ error: "Invalid or Missing eventId" }, { status: 400 }));
  }

  const { eventId } = parsed.data;

  const event = await findEventRecord(eventId, authenticatedEnv.id);

  if (!event) {
    return apiCors(request, json({ error: "Event not found" }, { status: 404 }));
  }

  return apiCors(request, json(toJSON(event)));
}

function toJSON(eventRecord: FoundEventRecord): GetEvent {
  return {
    id: eventRecord.eventId,
    name: eventRecord.name,
    createdAt: eventRecord.createdAt,
    updatedAt: eventRecord.updatedAt,
    runs: eventRecord.runs.map((run) => ({
      id: run.id,
      status: run.status,
      startedAt: run.startedAt,
      completedAt: run.completedAt,
    })),
  };
}

type FoundEventRecord = NonNullable<Awaited<ReturnType<typeof findEventRecord>>>;

async function findEventRecord(eventId: string, environmentId: string) {
  return await prisma.eventRecord.findUnique({
    select: {
      eventId: true,
      name: true,
      createdAt: true,
      updatedAt: true,
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
      eventId_environmentId: {
        eventId,
        environmentId,
      },
    },
  });
}
