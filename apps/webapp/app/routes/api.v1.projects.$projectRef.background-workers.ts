import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { CreateBackgroundWorkerRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { authenticateApiKeyWithScope } from "~/services/apiAuth.server";
import { DEV_WORKER_ACTION, DEV_WORKER_RESOURCE } from "~/services/devWorkerAuthorization.server";
import { logger } from "~/services/logger.server";
import { SchedulePlanLimitError } from "~/v3/freeSchedulePolicy.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  CreateBackgroundWorkerService,
  CreateDeclarativeScheduleError,
} from "~/v3/services/createBackgroundWorker.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

function declaresSchedulesOrWebhooks({ metadata }: CreateBackgroundWorkerRequestBody) {
  return (
    metadata.tasks.some((task) => task.schedule !== undefined) ||
    (metadata.webhookEndpoints?.length ?? 0) > 0 ||
    (metadata.webhookSubscribers?.length ?? 0) > 0
  );
}

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid params" }, { status: 400 });
  }

  try {
    const authResult = await authenticateApiKeyWithScope(request, {
      action: DEV_WORKER_ACTION,
      resource: DEV_WORKER_RESOURCE,
    });

    if (!authResult.ok) {
      logger.info("Background worker registration not authorized", { url: request.url });
      return json({ error: authResult.error }, { status: authResult.status });
    }

    const authenticatedEnv = authResult.authentication.environment;

    const { projectRef } = parsedParams.data;

    const rawBody = await request.json();
    const body = CreateBackgroundWorkerRequestBody.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid body", issues: body.error.issues }, { status: 400 });
    }

    // Schedules and webhooks act without a running dev session, so only full-access keys may
    // declare them.
    if (authResult.authentication.environmentScoped && declaresSchedulesOrWebhooks(body.data)) {
      return json(
        { error: "Declaring schedules or webhooks requires an API key with full access" },
        { status: 403 }
      );
    }

    const service = new CreateBackgroundWorkerService();

    try {
      const backgroundWorker = await service.call(projectRef, authenticatedEnv, body.data, {
        restricted: authResult.authentication.environmentScoped,
      });

      return json(
        {
          id: backgroundWorker.friendlyId,
          version: backgroundWorker.version,
          contentHash: backgroundWorker.contentHash,
          warnings: backgroundWorker.warnings,
        },
        { status: 200 }
      );
    } catch (e) {
      // Customer-facing validation failures (invalid task config, customer cron
      // expression, etc.). The handler returns 4xx with the message; system
      // handles it gracefully, no alert needed.
      if (e instanceof SchedulePlanLimitError) {
        logger.warn("Failed to create background worker", { error: e.message, projectRef });
        return json(
          { error: { code: "schedule_plan_limit", message: e.message } },
          { status: e.status ?? 422 }
        );
      }
      if (e instanceof ServiceValidationError) {
        logger.warn("Failed to create background worker", { error: e.message, projectRef });
        return json({ error: e.message }, { status: e.status ?? 400 });
      }
      if (e instanceof CreateDeclarativeScheduleError) {
        logger.warn("Failed to create background worker", { error: e.message, projectRef });
        return json({ error: e.message }, { status: 400 });
      }

      logger.error("Failed to create background worker", { error: e, projectRef });

      return json({ error: "Failed to create background worker" }, { status: 500 });
    }
  } catch (error) {
    if (error instanceof Response) throw error;
    logger.error("Failed to create project background worker", {
      error,
      projectRef: params.projectRef,
    });
    return json({ error: "Internal Server Error" }, { status: 500 });
  }
}
