import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { LogMessageSchema } from "@trigger.dev/core/schemas";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CreateRunLogService } from "./CreateRunLogService.server";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
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

  const { runId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await request.json();

  const body = LogMessageSchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new CreateRunLogService();

  try {
    const log = await service.call(authenticatedEnv, runId, body.data);

    return json(log);
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
