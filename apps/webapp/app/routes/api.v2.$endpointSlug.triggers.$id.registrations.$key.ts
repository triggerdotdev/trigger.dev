import type { ActionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import {
  REGISTER_SOURCE_EVENT_V2,
  RegisterSourceEventV2,
  RegisterTriggerBodySchemaV2,
} from "@trigger.dev/core";
import { z } from "zod";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { IngestSendEvent } from "~/services/events/ingestSendEvent.server";
import { logger } from "~/services/logger.server";
import { RegisterTriggerSourceServiceV2 } from "~/services/triggers/registerTriggerSourceV2.server";

const ParamsSchema = z.object({
  endpointSlug: z.string(),
  id: z.string(),
  key: z.string(),
});

export async function action({ request, params }: ActionArgs) {
  logger.info("Registering trigger", { url: request.url });

  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "PUT") {
    return { status: 405, body: "Method Not Allowed" };
  }

  const parsedParams = ParamsSchema.safeParse(params);

  if (!parsedParams.success) {
    logger.info("Invalid params", { params });

    return json({ error: "Invalid params" }, { status: 400 });
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    logger.info("Invalid or missing api key", { url: request.url });
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const authenticatedEnv = authenticationResult.environment;

  // Now parse the request body
  const anyBody = await request.json();

  const body = RegisterTriggerBodySchemaV2.safeParse(anyBody);

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new RegisterTriggerSourceServiceV2();

  try {
    const registration = await service.call({
      environment: authenticatedEnv,
      payload: body.data,
      endpointSlug: parsedParams.data.endpointSlug,
      id: parsedParams.data.id,
      key: parsedParams.data.key,
    });

    if (!registration) {
      return json({ error: "Could not register trigger" }, { status: 500 });
    }

    //the source is already active
    if (registration.source.active) {
      return json(registration);
    }

    const payload: RegisterSourceEventV2 = {
      ...registration,
      dynamicTriggerId: parsedParams.data.id,
    };

    const ingestEventService = new IngestSendEvent();
    await ingestEventService.call(
      authenticatedEnv,
      {
        id: registration.id,
        name: REGISTER_SOURCE_EVENT_V2,
        source: "trigger.dev",
        payload,
      }
      //todo accountId?
      // {accountId: body.data.accountId}
    );

    return json(registration);
  } catch (error) {
    if (error instanceof Error) {
      logger.error("Error registering trigger", {
        url: request.url,
        error: error.message,
      });

      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
