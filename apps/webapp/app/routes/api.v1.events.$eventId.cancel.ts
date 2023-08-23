import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { eventRecordToApiJson } from "~/api.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CancelEventService } from "~/services/events/cancelEvent.server";
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

  const service = new CancelEventService();
  try {
    const updatedEvent = await service.call(authenticatedEnv, eventId);

    if (!updatedEvent) {
      return json({ error: "Event not found" }, { status: 404 });
    }

    return json(eventRecordToApiJson(updatedEvent));
  } catch (err) {
    logger.error("CancelEventService.call() error", {
      error: err,
    });

    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
