import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { logger } from "~/services/logger.server";
import { CallbackRunTaskService } from "./CallbackRunTaskService.server";

const ParamsSchema = z.object({
  id: z.string(),
  secret: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const { id } = ParamsSchema.parse(params);

  // Parse body as JSON (no schema parsing)
  const body = await request.json();

  const service = new CallbackRunTaskService();

  try {
    // Complete task with request body as output
    await service.call(id, body, request.url);

    return json({ success: true });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error while processing task callback:", { error });

      return json({ error: `Something went wrong: ${error.message}` }, { status: 500 });
    }
    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
