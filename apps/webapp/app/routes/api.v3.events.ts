import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { SendEventBodySchema } from "@trigger.dev/internal";
import { generateErrorMessage } from "zod-error";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestSendEvent } from "~/services/events/ingestSendEvent.server";

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
    body.data.event,
    body.data.options
  );

  return json(event);
}
