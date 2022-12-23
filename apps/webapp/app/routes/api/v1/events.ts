import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestEvent } from "~/services/events/ingest.server";
import { CustomEventSchema } from "@trigger.dev/common-schemas";
import { ulid } from "ulid";

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

  const customEvent = CustomEventSchema.safeParse(body);

  if (!customEvent.success) {
    return json({ error: customEvent.error.message }, { status: 400 });
  }

  const service = new IngestEvent();

  const result = await service.call(
    {
      id: ulid(),
      name: customEvent.data.name,
      type: "CUSTOM_EVENT",
      service: "trigger",
      payload: customEvent.data.payload,
      context: customEvent.data.context,
      apiKey: authenticatedEnv.apiKey,
    },
    authenticatedEnv.organization
  );

  return json(result.data);
}
