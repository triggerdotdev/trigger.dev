import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { CreateEndpointService } from "~/services/endpoints/createEndpoint.server";
import { logger } from "~/services/logger";

const BodySchema = z.object({
  url: z.string(),
  id: z.string(),
});

export async function action({ request }: ActionArgs) {
  logger.info("action", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    logger.info("Invalid or missing api key", { url: request.url });

    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  // Now parse the request body
  const anyBody = await request.json();

  const body = BodySchema.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  logger.info("Creating endpoint", {
    url: request.url,
    endpoint: body.data,
  });

  const service = new CreateEndpointService();

  try {
    const endpoint = await service.call({
      environment: authenticatedEnv,
      url: body.data.url,
      id: body.data.id,
    });

    return json(endpoint);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error creating endpoint", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
