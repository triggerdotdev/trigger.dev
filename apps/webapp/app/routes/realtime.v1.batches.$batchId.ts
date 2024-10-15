import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { permittedToReadBatch } from "~/services/accessControl.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { realtimeClient } from "~/services/realtimeClientGlobal.server";
import { makeApiCors } from "~/utils/apiCors";

const ParamsSchema = z.object({
  batchId: z.string(),
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

  if (!permittedToReadBatch(authenticationResult, parsedParams.data.batchId)) {
    return apiCors(json({ error: "Unauthorized" }, { status: 403 }));
  }

  try {
    const batchRun = await $replica.batchTaskRun.findFirst({
      where: {
        friendlyId: parsedParams.data.batchId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
    });

    if (!batchRun) {
      return apiCors(json({ error: "Batch Run not found" }, { status: 404 }));
    }

    return realtimeClient.streamRunsWhere(
      request.url,
      authenticationResult.environment,
      `"batchId"='${batchRun.id}'`
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
