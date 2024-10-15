import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { permittedToReadRun, permittedToReadRunTag } from "~/services/accessControl.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { makeApiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  tagName: z.string(),
});

export async function loader({ request, params }: ActionFunctionArgs) {
  const apiCors = makeApiCors(request);

  if (request.method.toUpperCase() === "OPTIONS") {
    return apiCors(json({}));
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request, { allowJWT: true });

  if (!authenticationResult) {
    return apiCors(json({ error: "Invalid or Missing API Key" }, { status: 401 }));
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return apiCors(
      json(
        { error: "Invalid request parameters", issues: parsedParams.error.issues },
        { status: 400 }
      )
    );
  }

  if (!permittedToReadRunTag(authenticationResult, parsedParams.data.tagName)) {
    return apiCors(json({ error: "Unauthorized" }, { status: 403 }));
  }

  try {
    return realtimeClient.streamRunsWhere(
      request.url,
      authenticationResult.environment,
      `"runTags" @> ARRAY['${parsedParams.data.tagName}']`,
      apiCors
    );
  } catch (error) {
    if (error instanceof Response) {
      // Error responses from longPollingFetch
      return apiCors(error);
    } else if (error instanceof TypeError) {
      // Unexpected errors
      logger.error("Unexpected error in loader:", { error: error.message });
      return apiCors(new Response("An unexpected error occurred", { status: 500 }));
    } else {
      // Unknown errors
      logger.error("Unknown error occurred in loader, not Error", { error: JSON.stringify(error) });
      return apiCors(new Response("An unknown error occurred", { status: 500 }));
    }
  }
}
