import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { ScheduleObject, UpdateScheduleOptions } from "@trigger.dev/core/v3";
import { z } from "zod";
import { Prisma, prisma } from "~/db.server";
import { ViewSchedulePresenter } from "~/presenters/v3/ViewSchedulePresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { UpsertSchedule } from "~/v3/schedules";
import { ServiceValidationError } from "~/v3/services/baseService.server";
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
      try {
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
      } catch (error) {
        // Check if it's a Prisma error
        if (error instanceof Prisma.PrismaClientKnownRequestError) {
          return json(
            { error: error.code === "P2025" ? "Schedule not found" : error.message },
            { status: error.code === "P2025" ? 404 : 422 }
          );
        } else {
          return json(
            { error: error instanceof Error ? error.message : "Internal Server Error" },
            { status: 500 }
          );
        }
      }
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
          timezone: body.data.timezone,
          environments: [authenticationResult.environment.id],
          externalId: body.data.externalId,
        };

        const schedule = await service.call(authenticationResult.environment.projectId, options);

        const responseObject: ScheduleObject = {
          id: schedule.id,
          type: schedule.type,
          task: schedule.task,
          active: schedule.active,
          generator: {
            type: "CRON",
            expression: schedule.cron,
            description: schedule.cronDescription,
          },
          timezone: schedule.timezone,
          externalId: schedule.externalId ?? undefined,
          deduplicationKey: schedule.deduplicationKey,
          environments: schedule.environments,
          nextRun: schedule.nextRun,
        };

        return json(responseObject, { status: 200 });
      } catch (error) {
        if (error instanceof ServiceValidationError) {
          return json({ error: error.message }, { status: 422 });
        }

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
    environmentId: authenticationResult.environment.id,
  });

  if (!result) {
    return json({ error: "Schedule not found" }, { status: 404 });
  }

  return json(presenter.toJSONResponse(result), { status: 200 });
}
