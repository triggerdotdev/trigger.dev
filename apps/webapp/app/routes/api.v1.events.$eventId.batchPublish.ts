import { json } from "@remix-run/server-runtime";
import { BatchPublishEventRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  EventPublishRateLimitError,
  PublishEventService,
  PublishEventResult,
} from "~/v3/services/events/publishEvent.server";
import { writeEventLog } from "~/v3/services/events/eventLogWriter.server";
import { eventPublishRateLimitChecker } from "~/v3/services/events/eventRateLimiterGlobal.server";

const ParamsSchema = z.object({
  eventId: z.string(),
});

const { action, loader } = createActionApiRoute(
  {
    params: ParamsSchema,
    body: BatchPublishEventRequestBody,
    corsStrategy: "all",
    authorization: {
      action: "trigger",
      resource: (params) => ({ tasks: params.eventId }),
      superScopes: ["write:tasks", "admin"],
    },
  },
  async ({ body, params, authentication }) => {
    const service = new PublishEventService(
      undefined,
      undefined,
      writeEventLog,
      eventPublishRateLimitChecker
    );

    const results: Array<
      | { ok: true; eventId: string; runs: PublishEventResult["runs"] }
      | { ok: false; error: string }
    > = [];

    for (const item of body.items) {
      try {
        const result = await service.call(
          params.eventId,
          authentication.environment,
          item.payload,
          {
            idempotencyKey: item.options?.idempotencyKey,
            delay: item.options?.delay,
            tags: item.options?.tags,
            metadata: item.options?.metadata,
            context: item.options?.context,
            orderingKey: item.options?.orderingKey,
          }
        );

        results.push({ ok: true, eventId: result.eventId, runs: result.runs });
      } catch (error) {
        if (error instanceof EventPublishRateLimitError) {
          results.push({ ok: false, error: error.message });
        } else if (error instanceof ServiceValidationError) {
          results.push({ ok: false, error: error.message });
        } else {
          results.push({
            ok: false,
            error: error instanceof Error ? error.message : "Unknown error",
          });
        }
      }
    }

    const hasErrors = results.some((r) => !r.ok);
    return json({ results }, { status: hasErrors ? 207 : 200 });
  }
);

export { action, loader };
