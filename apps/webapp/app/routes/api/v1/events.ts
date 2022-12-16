import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestEvent } from "~/services/events/ingest.server";

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

  const service = new IngestEvent();

  const result = await service.call(
    body,
    authenticatedEnv.organization,
    authenticatedEnv
  );

  switch (result.status) {
    case "validationError":
      return json({ error: result.errors }, { status: 400 });
    case "success":
      return json(result.data);
  }
}
