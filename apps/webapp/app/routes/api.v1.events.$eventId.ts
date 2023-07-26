import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { cors } from "remix-utils";
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
    return apiCors(
      request,
      json({ error: "Invalid or Missing API key" }, { status: 401 })
    );
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return apiCors(
      request,
      json({ error: "Invalid or Missing eventId" }, { status: 400 })
    );
  }

  const { eventId } = parsed.data;

  const event = await prisma.eventRecord.findFirst({
    select: {
      id: true,
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
      id: eventId,
      environmentId: authenticatedEnv.id,
    },
  });

  if (!event) {
    return apiCors(
      request,
      json({ error: "Event not found" }, { status: 404 })
    );
  }

  return apiCors(request, json(event));
}
