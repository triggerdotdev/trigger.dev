import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { z } from "zod";
import {
  ApiAlertChannelPresenter,
  ApiCreateAlertChannel,
} from "~/presenters/v3/ApiAlertChannelPresenter.server";
import { authenticateApiRequestWithPersonalAccessToken } from "~/services/personalAccessToken.server";
import { CreateAlertChannelService } from "~/v3/services/alerts/createAlertChannel.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";

const ParamsSchema = z.object({
  projectRef: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  const authenticationResult = await authenticateApiRequestWithPersonalAccessToken(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing Access Token" }, { status: 401 });
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    return json({ error: "Invalid Params" }, { status: 400 });
  }

  const { projectRef } = parsedParams.data;

  const rawBody = await request.json();

  const body = ApiCreateAlertChannel.safeParse(rawBody);

  if (!body.success) {
    return json({ error: "Invalid request body", issues: body.error.issues }, { status: 400 });
  }

  const service = new CreateAlertChannelService();

  try {
    if (body.data.channel === "email") {
      if (!body.data.channelData.email) {
        return json({ error: "Email is required" }, { status: 422 });
      }

      const alertChannel = await service.call(projectRef, authenticationResult.userId, {
        name: body.data.name,
        alertTypes: body.data.alertTypes.map((type) =>
          ApiAlertChannelPresenter.alertTypeFromApi(type)
        ),
        channel: {
          type: "EMAIL",
          email: body.data.channelData.email,
        },
        deduplicationKey: body.data.deduplicationKey,
        environmentTypes: body.data.environmentTypes,
      });

      return json(await ApiAlertChannelPresenter.alertChannelToApi(alertChannel));
    }

    if (body.data.channel === "webhook") {
      if (!body.data.channelData.url) {
        return json({ error: "webhook url is required" }, { status: 422 });
      }

      const alertChannel = await service.call(projectRef, authenticationResult.userId, {
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
        environmentTypes: body.data.environmentTypes,
      });

      return json(await ApiAlertChannelPresenter.alertChannelToApi(alertChannel));
    }

    return json({ error: "Invalid channel type" }, { status: 422 });
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
