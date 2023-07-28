import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { UnregisterScheduleService } from "~/services/schedules/unregisterSchedule.server";

const ParamsSchema = z.object({
  endpointSlug: z.string(),
  id: z.string(),
  key: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  logger.info("Unregistering schedule", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "DELETE") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const service = new UnregisterScheduleService();

  try {
    await service.call({
      environment: authenticatedEnv,
      endpointSlug: parsedParams.data.endpointSlug,
      id: parsedParams.data.id,
      key: parsedParams.data.key,
    });

    return json({ ok: true });
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error unregistering schedule", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
