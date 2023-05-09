import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { CreateRunBodySchema } from "@trigger.dev/internal";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { PostRunService } from "~/services/runs/postRun.server";

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

  const body = CreateRunBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new PostRunService();

  try {
    const execution = await service.call(authenticatedEnv, body.data);

    if (!execution) {
      return json({ ok: false, error: "Failed to create execution" });
    }

    return json({ ok: true, data: execution });
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
