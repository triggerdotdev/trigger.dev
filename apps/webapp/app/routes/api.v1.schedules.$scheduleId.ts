import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { UpdateScheduleOptions } from "@trigger.dev/core/v3";
import { z } from "zod";
import { prisma } from "~/db.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { UpsertSchedule } from "~/v3/schedules";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";

const ParamsSchema = z.object({
  scheduleId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
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

  const method = request.method.toUpperCase();

  switch (method) {
    case "DELETE": {
      const deletedSchedule = await prisma.taskSchedule.delete({
        where: {
          friendlyId: parsedParams.data.scheduleId,
          projectId: authenticationResult.environment.projectId,
        },
      });

      return json(
        {
          id: deletedSchedule.friendlyId,
        },
        { status: 200 }
      );
    }
    case "PUT": {
      const rawBody = await request.json();

      const body = UpdateScheduleOptions.safeParse(rawBody);

      if (!body.success) {
        return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
      }

      const service = new UpsertTaskScheduleService();

      try {
        const options: UpsertSchedule = {
          friendlyId: parsedParams.data.scheduleId,
          taskIdentifier: body.data.task,
          cron: body.data.cron,
          environments: [authenticationResult.environment.id],
          externalId: body.data.externalId,
          deduplicationKey: body.data.deduplicationKey,
        };

        const schedule = await service.call(authenticationResult.environment.projectId, options);

        return json(schedule, { status: 200 });
      } catch (error) {
        return json(
          { error: error instanceof Error ? error.message : "Internal Server Error" },
          { status: 500 }
        );
      }
    }
  }
}

export async function loader({ request, params }: LoaderFunctionArgs) {
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

  const presenter = new ViewSchedulePresenter();

  const result = await presenter.call({
    projectId: authenticationResult.environment.projectId,
    friendlyId: parsedParams.data.scheduleId,
  });

  if (!result) {
    return json({ error: "Schedule not found" }, { status: 404 });
  }

  return json(presenter.toJSONResponse(result), { status: 200 });
}
