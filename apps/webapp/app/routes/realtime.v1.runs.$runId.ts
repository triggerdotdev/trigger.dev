import { type ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { z } from "zod";
import { $replica } from "~/db.server";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { longPollingFetch } from "~/utils/longPollingFetch";

const ParamsSchema = z.object({
  runId: z.string(),
});

export async function loader({ request, params }: ActionFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);
  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json(
      { error: "Invalid request parameters", issues: parsedParams.error.issues },
      { status: 400 }
    );
  }

  try {
    const run = await $replica.taskRun.findFirst({
      where: {
        friendlyId: parsedParams.data.runId,
        runtimeEnvironmentId: authenticationResult.environment.id,
      },
    });

    if (!run) {
      return json({ error: "Task Run not found" }, { status: 404 });
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
      return error;
    } else if (error instanceof TypeError) {
      // Unexpected errors
      logger.error("Unexpected error in loader:", { error: error.message });
      return new Response("An unexpected error occurred", { status: 500 });
    } else {
      // Unknown errors
      logger.error("Unknown error occurred in loader, not Error", { error: JSON.stringify(error) });
      return new Response("An unknown error occurred", { status: 500 });
    }
  }
}
