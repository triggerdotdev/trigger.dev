import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { getScheduleEnvVisibility, scheduleUniqWhereClause } from "~/models/schedules.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";

const ParamsSchema = z.object({
  scheduleId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

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
    // Env-scoped API keys can only toggle schedules that have an instance in
    // their own environment. Without this a key scoped to one environment
    // could enable/disable a schedule that only runs in another environment
    // of the same project.
    const visibility = await getScheduleEnvVisibility(
      prisma,
      authenticationResult.environment.projectId,
      parsedParams.data.scheduleId,
      authenticationResult.environment.id
    );
    if (visibility.status !== "visible") {
      return json({ error: "Schedule not found" }, { status: 404 });
    }

    await prisma.taskSchedule.update({
      where: scheduleUniqWhereClause(
        authenticationResult.environment.projectId,
        parsedParams.data.scheduleId
      ),
      data: {
        active: true,
      },
    });

    const presenter = new ViewSchedulePresenter();

    const result = await presenter.call({
      projectId: authenticationResult.environment.projectId,
      friendlyId: parsedParams.data.scheduleId,
      environmentId: authenticationResult.environment.id,
    });

    if (!result) {
      return json({ error: "Schedule not found" }, { status: 404 });
    }

    return json(presenter.toJSONResponse(result), { status: 200 });
  } catch (error) {
    logger.error("Failed to activate schedule", { error });
    return json({ error: "Something went wrong, please try again." }, { status: 500 });
  }
}
