import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { UpdateWebhookBodySchema } from "@trigger.dev/core/schemas";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { UpdateWebhookService } from "~/services/sources/updateWebhook.server";

const ParamsSchema = z.object({
  key: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  logger.info("Updating webhook", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
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

  // Now parse the request body
  const anyBody = await request.json();

  const body = UpdateWebhookBodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new UpdateWebhookService();

  try {
    const source = await service.call({
      environment: authenticatedEnv,
      payload: body.data,
      key: parsedParams.data.key,
    });

    return json(source);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error updating webhook", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
