import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { CreateImageDetailsRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { CreateImageDetailsService } from "~/v3/services/createImageDetails.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
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

  const { projectRef } = parsedParams.data;

  const rawBody = await request.json();
  const body = CreateImageDetailsRequestBody.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
  }

  const service = new CreateImageDetailsService();

  const imageDetails = await service.call(projectRef, authenticatedEnv, body.data);

  return json(
    {
      id: imageDetails.friendlyId,
      contentHash: imageDetails.contentHash,
    },
    { status: 200 }
  );
}
