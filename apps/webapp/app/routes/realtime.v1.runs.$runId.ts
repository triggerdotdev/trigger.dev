import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { permittedToReadRun } from "~/services/accessControl.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { makeApiCors } from "~/utils/apiCors";
import { longPollingFetch } from "~/utils/longPollingFetch";

const ParamsSchema = z.object({
  runId: z.string(),
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

  if (!permittedToReadRun(authenticationResult, parsedParams.data.runId)) {
    return apiCors(json({ error: "Unauthorized" }, { status: 403 }));
  }

  try {
    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
    });

    if (!run) {
      return apiCors(json({ error: "Task Run not found" }, { status: 404 }));
    }

    const url = new URL(request.url);
    const originUrl = new URL(`${env.ELECTRIC_ORIGIN}/v1/shape/public."TaskRun"`);
    url.searchParams.forEach((value, key) => {
      originUrl.searchParams.set(key, value);
    });

    originUrl.searchParams.set("where", `"id"='${run.id}'`);

    const finalUrl = originUrl.toString();

    return longPollingFetch(finalUrl);
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
