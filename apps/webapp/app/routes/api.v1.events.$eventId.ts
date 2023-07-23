import type { ActionArgs, LoaderArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { cors } from "remix-utils";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

export async function loader({ request, params }: LoaderArgs) {
  if (request.method.toUpperCase() === "OPTIONS") {
    return cors(request, json({}));
  }

  //todo allow use of client API key
  const authenticatedEnv = await authenticateApiRequest(request);
  if (!authenticatedEnv) {
    return cors(
      request,
      json({ error: "Invalid or Missing API key" }, { status: 401 })
    );
  }

  const { eventId } = ParamsSchema.parse(params);

  const event = await prisma.eventRecord.findUnique({
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
    },
  });

  return cors(request, json(event));
}
