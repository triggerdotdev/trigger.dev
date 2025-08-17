import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import { prisma } from "~/db.server";
import { scheduleUniqWhereClause, scheduleWhereClause } from "~/models/schedules.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";

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
    const existingSchedule = await prisma.taskSchedule.findFirst({
      where: scheduleWhereClause(
        authenticationResult.environment.projectId,
        parsedParams.data.scheduleId
      ),
    });

    if (!existingSchedule) {
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
    return json(
      { error: error instanceof Error ? error.message : "Internal Server Error" },
      { status: 500 }
    );
  }
}
