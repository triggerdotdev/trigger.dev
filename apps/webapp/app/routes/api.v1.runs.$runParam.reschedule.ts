import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { RescheduleRunRequestBody } from "@trigger.dev/core/v3/schemas";
import { z } from "zod";
import { getApiVersion } from "~/api/versions";
import { prisma } from "~/db.server";
import { ApiRetrieveRunPresenter } from "~/presenters/v3/ApiRetrieveRunPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { RescheduleTaskRunService } from "~/v3/services/rescheduleTaskRun.server";

const ParamsSchema = z.object({
  runParam: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or missing API Key" }, { status: 401 });
  }

  const parsed = ParamsSchema.safeParse(params);

  if (!parsed.success) {
    return json({ error: "Invalid or missing run ID" }, { status: 400 });
  }

  const { runParam } = parsed.data;

  const taskRun = await prisma.taskRun.findUnique({
    where: {
      friendlyId: runParam,
      runtimeEnvironmentId: authenticationResult.environment.id,
    },
  });

  if (!taskRun) {
    return json({ error: "Run not found" }, { status: 404 });
  }

  const anyBody = await request.json();

  const body = RescheduleRunRequestBody.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new RescheduleTaskRunService();

  try {
    const updatedRun = await service.call(taskRun, body.data);

    if (!updatedRun) {
      return json({ error: "An unknown error occurred" }, { status: 500 });
    }

    const run = await ApiRetrieveRunPresenter.findRun(
      updatedRun.friendlyId,
      authenticationResult.environment
    );

    if (!run) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    const apiVersion = getApiVersion(request);

    const presenter = new ApiRetrieveRunPresenter(apiVersion);
    const result = await presenter.call(run, authenticationResult.environment);

    if (!result) {
      return json({ error: "Run not found" }, { status: 404 });
    }

    return json(result);
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 400 });
    } else if (error instanceof Error) {
      return json({ error: error.message }, { status: 500 });
    } else {
      return json({ error: "An unknown error occurred" }, { status: 500 });
    }
  }
}
