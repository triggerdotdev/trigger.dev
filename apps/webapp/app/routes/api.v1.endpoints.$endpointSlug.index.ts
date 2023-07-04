import { ActionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IndexEndpointService } from "~/services/endpoints/indexEndpoint.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  endpointSlug: z.string(),
});

const BodySchema = z.object({
  reason: z.string().optional(),
  data: z.any().optional(),
});

export async function action({ request, params }: ActionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticatedEnv = await authenticateApiRequest(request);

  if (!authenticatedEnv) {
    logger.info("Invalid or missing api key", { url: request.url });

    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const { endpointSlug } = parsedParams.data;

  const endpoint = await prisma.endpoint.findUnique({
    where: {
      environmentId_slug: {
        environmentId: authenticatedEnv.id,
        slug: endpointSlug,
      },
    },
  });

  if (!endpoint) {
    logger.info("Endpoint not found", { url: request.url });

    return json({ error: "Endpoint not found" }, { status: 404 });
  }

  const body = await request.json();

  const parsedBody = BodySchema.safeParse(body);

  if (!parsedBody.success) {
    return json({ error: "Invalid body" }, { status: 400 });
  }

  const service = new IndexEndpointService();

  try {
    const indexing = await service.call(
      endpoint.id,
      "API",
      parsedBody.data.reason,
      parsedBody.data.data
    );

    if (!indexing) {
      return json({ error: "Something went wrong" }, { status: 500 });
    }

    const { data, ...index } = indexing;

    return json(index);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error indexing endpoint", {
        url: request.url,
        error: {
          name: error.name,
          message: error.message,
          stack: error.stack,
        },
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
