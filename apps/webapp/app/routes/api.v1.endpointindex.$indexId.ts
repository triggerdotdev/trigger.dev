import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import {
  EndpointIndexErrorSchema,
  GetEndpointIndexResponse,
  GetEndpointIndexResponseSchema,
} from "@trigger.dev/core";
import { z } from "zod";
import { prisma } from "~/db.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IndexEndpointService } from "~/services/endpoints/indexEndpoint.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  indexId: z.string(),
});

export async function loader({ request, params }: ActionFunctionArgs) {
  if (request.method.toUpperCase() !== "GET") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const { indexId } = parsedParams.data;

  const endpointIndex = await prisma.endpointIndex.findUnique({
    where: {
      id: indexId,
      endpoint: {
        environmentId: authenticatedEnv.id,
      },
    },
  });

  if (!endpointIndex) {
    logger.info("EndpointIndex not found", { url: request.url });
    return json({ error: "EndpointIndex not found" }, { status: 404 });
  }

  const parsed = GetEndpointIndexResponseSchema.safeParse(endpointIndex);

  if (!parsed.success) {
    logger.info("EndpointIndex failed parsing", { errors: parsed.error.issues, endpointIndex });
    const parseFailResult: GetEndpointIndexResponse = {
      status: "FAILURE",
      error: {
        message: "Invalid endpoint index",
      },
      updatedAt: new Date(),
    };
    return json(parseFailResult, { status: 500 });
  }

  return json(parsed.data);
}
