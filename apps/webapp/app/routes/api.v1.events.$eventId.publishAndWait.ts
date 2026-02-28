import { json } from "@remix-run/server-runtime";
import { PublishAndWaitEventRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  EventPublishRateLimitError,
  PublishEventService,
} from "~/v3/services/events/publishEvent.server";
import { writeEventLog } from "~/v3/services/events/eventLogWriter.server";
import { eventPublishRateLimitChecker } from "~/v3/services/events/eventRateLimiterGlobal.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: PublishAndWaitEventRequestBody,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.eventId }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ body, params, authentication }) => {
    const parentRunId = body.options?.parentRunId;
    if (!parentRunId) {
      return json(
        { error: "parentRunId is required for publishAndWait" },
        { status: 400 }
      );
    }

    const service = new PublishEventService(
      undefined,
      undefined,
      writeEventLog,
      eventPublishRateLimitChecker
    );

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
          orderingKey: body.options?.orderingKey,
          parentRunId,
        }
      );

      return json(
        {
          eventId: result.eventId,
          runs: result.runs.map((r) => ({
            taskIdentifier: r.taskIdentifier,
            runId: r.runId,
          })),
        },
        { status: 200 }
      );
    } catch (error) {
      if (error instanceof EventPublishRateLimitError) {
        return json(
          { error: error.message },
          {
            status: 429,
            headers: {
              "x-ratelimit-limit": String(error.limit),
              "x-ratelimit-remaining": String(error.remaining),
              "retry-after": String(Math.ceil(error.retryAfterMs / 1000)),
            },
          }
        );
      } else if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: error.status ?? 422 });
      } else if (error instanceof Error) {
        return json({ error: error.message }, { status: 500 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action, loader };
