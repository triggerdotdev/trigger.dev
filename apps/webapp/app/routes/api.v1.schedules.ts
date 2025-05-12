import type { ActionFunctionArgs, LoaderFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { CreateScheduleOptions, ScheduleObject } from "@trigger.dev/core/v3";
import { z } from "zod";
import { ScheduleListPresenter } from "~/presenters/v3/ScheduleListPresenter.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { UpsertSchedule } from "~/v3/schedules";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { UpsertTaskScheduleService } from "~/v3/services/upsertTaskSchedule.server";

const SearchParamsSchema = z.object({
  page: z.coerce.number().int().positive().optional(),
  perPage: z.coerce.number().int().positive().optional(),
});

export async function action({ request }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const rawBody = await request.json();

  const body = CreateScheduleOptions.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const service = new UpsertTaskScheduleService();

  try {
    const options: UpsertSchedule = {
      taskIdentifier: body.data.task,
      cron: body.data.cron,
      environments: [authenticationResult.environment.id],
      externalId: body.data.externalId,
      deduplicationKey: body.data.deduplicationKey,
      timezone: body.data.timezone,
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

export async function loader({ request }: LoaderFunctionArgs) {
  // Authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API Key" }, { status: 401 });
  }

  const rawSearchParams = new URL(request.url).searchParams;
  const params = SearchParamsSchema.safeParse(Object.fromEntries(rawSearchParams.entries()));

  if (!params.success) {
    return json(
      { error: "Invalid request parameters", issues: params.error.issues },
      { status: 400 }
    );
  }

  const presenter = new ScheduleListPresenter();

  const result = await presenter.call({
    projectId: authenticationResult.environment.projectId,
    environmentId: authenticationResult.environment.id,
    page: params.data.page ?? 1,
    pageSize: params.data.perPage,
  });

  return {
    data: result.schedules.map((schedule) => ({
      id: schedule.friendlyId,
      type: schedule.type,
      task: schedule.taskIdentifier,
      generator: {
        type: "CRON",
        expression: schedule.cron,
        description: schedule.cronDescription,
      },
      timezone: schedule.timezone,
      deduplicationKey: schedule.userProvidedDeduplicationKey
        ? schedule.deduplicationKey
        : undefined,
      externalId: schedule.externalId,
      active: schedule.active,
      nextRun: schedule.nextRun,
      environments: schedule.environments,
    })),
    pagination: {
      currentPage: result.currentPage,
      totalPages: result.totalPages,
      count: result.totalCount,
    },
  };
}
