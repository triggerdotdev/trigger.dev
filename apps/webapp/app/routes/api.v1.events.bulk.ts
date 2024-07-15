import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { SendBulkEventsBodySchema } from '@trigger.dev/core/schemas';
import { generateErrorMessage } from "zod-error";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestSendEvent } from "~/services/events/ingestSendEvent.server";
import { eventRecordToApiJson } from "~/api.server";
import { type EventRecord } from "@trigger.dev/database";

export async function action({ request }: ActionFunctionArgs) {
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

  // Now parse the request body
  const anyBody = await request.json();

  const body = SendBulkEventsBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ message: generateErrorMessage(body.error.issues) }, { status: 422 });
  }

  const service = new IngestSendEvent();

  const events: EventRecord[] = [];

  for (const event of body.data.events) {
    const eventRecord = await service.call(authenticatedEnv, event, body.data.options);

    if (!eventRecord) {
      return json({ error: "Failed to create event during bulk ingest" }, { status: 500 });
    }

    events.push(eventRecord);
  }

  return json(events.map(eventRecordToApiJson));
}
