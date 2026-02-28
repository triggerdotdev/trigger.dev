import { json } from "@remix-run/server-runtime";
import { ReplayEventsRequestBody } from "@trigger.dev/core/v3";
import type { EventFilter } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { clickhouseClient } from "~/services/clickhouseInstance.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { ReplayEventsService } from "~/v3/services/events/replayEvents.server";
import { writeEventLog } from "~/v3/services/events/eventLogWriter.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: ReplayEventsRequestBody,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.eventId }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ body, params, authentication }) => {
    const service = new ReplayEventsService(
      clickhouseClient,
      undefined,
      undefined,
      writeEventLog
    );

    try {
      const result = await service.call({
        eventSlug: params.eventId,
        environment: authentication.environment,
        from: body.from,
        to: body.to,
        filter: body.filter as EventFilter | undefined,
        tasks: body.tasks,
        dryRun: body.dryRun,
      });

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
