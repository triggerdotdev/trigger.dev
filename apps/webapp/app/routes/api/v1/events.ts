import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { CustomEventSchema } from "@trigger.dev/common-schemas";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestEvent } from "~/services/events/ingest.server";

const EventBodySchema = z.object({
  id: z.string(),
  event: CustomEventSchema,
});

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
  const body = await request.json();

  const eventBody = EventBodySchema.safeParse(body);

  if (!eventBody.success) {
    return json({ error: eventBody.error.message }, { status: 400 });
  }

  const service = new IngestEvent();

  const result = await service.call(
    {
      id: eventBody.data.id,
      name: eventBody.data.event.name,
      type: "CUSTOM_EVENT",
      service: "trigger",
      payload: eventBody.data.event.payload,
      context: eventBody.data.event.context,
      apiKey: authenticatedEnv.apiKey,
    },
    authenticatedEnv.organization
  );

  return json(result.data);
}
