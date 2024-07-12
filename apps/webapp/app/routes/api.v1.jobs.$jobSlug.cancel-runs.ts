import { json ,type  ActionFunctionArgs  } from "@remix-run/server-runtime";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { CancelRunsForJobService } from "~/services/jobs/cancelRunsForJob.server";

const ParamsSchema = z.object({
  jobSlug: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return json({ error: "Invalid or Missing jobSlug" }, { status: 400 });
  }

  const { jobSlug } = parsed.data;

  const service = new CancelRunsForJobService();
  try {
    const res = await service.call(authenticatedEnv, jobSlug);

    if (!res) {
      return json({ error: "Job not found" }, { status: 404 });
    }

    return json(res);
  } catch (err) {
    logger.error("CancelRunsForJobService.call() error", { error: err });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
