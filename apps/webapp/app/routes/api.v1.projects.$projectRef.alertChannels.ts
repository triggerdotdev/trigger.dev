import { json } from "@remix-run/server-runtime";
import type { RuntimeEnvironmentType } from "@trigger.dev/database";
import { z } from "zod";
import { prisma } from "~/db.server";
import { findProjectByRef } from "~/models/project.server";
import {
  ApiAlertChannelPresenter,
  ApiCreateAlertChannel,
} from "~/presenters/v3/ApiAlertChannelPresenter.server";
import { logger } from "~/services/logger.server";
import {
  alertsEnvironmentForbidden,
  alertsInAnyEnvironment,
  monitoringAlertsRouteContext,
} from "~/services/monitoringAlertsApi.server";
import { createActionPATApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  AlertChannelChangedError,
  type CreateAlertChannelOptions,
  CreateAlertChannelService,
} from "~/v3/services/alerts/createAlertChannel.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export const action = createActionPATApiRoute(
  {
    method: "POST",
    params: ParamsSchema,
    context: monitoringAlertsRouteContext,
    authorization: { action: "write", resource: alertsInAnyEnvironment },
  },
  async ({ request, params, authentication, ability }) => {
    if (authentication.userActor) {
      return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
    }

    const { projectRef } = params;

    const rawBody = await request.json();

    const body = ApiCreateAlertChannel.safeParse(rawBody);

    if (!body.success) {
      return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
    }

    const environmentTypes: RuntimeEnvironmentType[] =
      body.data.environmentTypes.length === 0
        ? ["STAGING", "PRODUCTION"]
        : [...body.data.environmentTypes];
    let authorizedChannel: CreateAlertChannelOptions["authorizedChannel"];
    if (body.data.deduplicationKey) {
      const project = await findProjectByRef(projectRef, authentication.userId);
      authorizedChannel = project
        ? await prisma.projectAlertChannel.findFirst({
            where: { projectId: project.id, deduplicationKey: body.data.deduplicationKey },
            select: { id: true, environmentTypes: true },
          })
        : undefined;
      environmentTypes.push(...(authorizedChannel?.environmentTypes ?? []));
    }
    if (!environmentTypes.every((envType) => ability.can("write", { type: "alerts", envType }))) {
      return alertsEnvironmentForbidden("write");
    }

    const service = new CreateAlertChannelService();

    try {
      if (body.data.channel === "email") {
        if (!body.data.channelData.email) {
          return json({ error: "Email is required" }, { status: 422 });
        }

        const alertChannel = await service.call(projectRef, authentication.userId, {
          name: body.data.name,
          alertTypes: body.data.alertTypes.map((type) =>
            ApiAlertChannelPresenter.alertTypeFromApi(type)
          ),
          channel: {
            type: "EMAIL",
            email: body.data.channelData.email,
          },
          deduplicationKey: body.data.deduplicationKey,
          authorizedChannel,
          environmentTypes: body.data.environmentTypes,
        });

        return json(await ApiAlertChannelPresenter.alertChannelToApi(alertChannel));
      }

      if (body.data.channel === "webhook") {
        if (!body.data.channelData.url) {
          return json({ error: "webhook url is required" }, { status: 422 });
        }

        // The webhook URL is validated in CreateAlertChannelService.call();
        // an unsafe URL surfaces as a ServiceValidationError -> 422 below.
        const alertChannel = await service.call(projectRef, authentication.userId, {
          name: body.data.name,
          alertTypes: body.data.alertTypes.map((type) =>
            ApiAlertChannelPresenter.alertTypeFromApi(type)
          ),
          channel: {
            type: "WEBHOOK",
            url: body.data.channelData.url,
            secret: body.data.channelData.secret,
          },
          deduplicationKey: body.data.deduplicationKey,
          authorizedChannel,
          environmentTypes: body.data.environmentTypes,
        });

        return json(await ApiAlertChannelPresenter.alertChannelToApi(alertChannel));
      }

      return json({ error: "Invalid channel type" }, { status: 422 });
    } catch (error) {
      if (error instanceof AlertChannelChangedError) {
        return json({ error: error.message }, { status: 409 });
      }
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      }

      logger.error("Failed to create alert channel", { error, projectRef });
      return json({ error: "Something went wrong, please try again." }, { status: 500 });
    }
  }
);
