import { json } from "@remix-run/server-runtime";
import { PublishEventRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { PublishEventService } from "~/v3/services/events/publishEvent.server";
import { writeEventLog } from "~/v3/services/events/eventLogWriter.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: PublishEventRequestBody,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.eventId }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ body, params, authentication }) => {
    const service = new PublishEventService(undefined, undefined, writeEventLog);

    try {
      const result = await service.call(
        params.eventId,
        authentication.environment,
        body.payload,
        {
          idempotencyKey: body.options?.idempotencyKey,
          delay: body.options?.delay,
          tags: body.options?.tags,
          metadata: body.options?.metadata,
          context: body.options?.context,
        }
      );

      return json(result, { status: 200 });
    } catch (error) {
      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      } else if (error instanceof Error) {
        return json({ error: error.message }, { status: 500 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action, loader };
