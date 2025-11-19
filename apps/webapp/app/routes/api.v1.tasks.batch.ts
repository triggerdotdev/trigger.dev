import { json } from "@remix-run/server-runtime";
import {
  BatchTriggerTaskV2RequestBody,
  BatchTriggerTaskV2Response,
  generateJWT,
} from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { AuthenticatedEnvironment, getOneTimeUseToken } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { resolveIdempotencyKeyTTL } from "~/utils/idempotencyKeys.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import {
  BatchProcessingStrategy,
  BatchTriggerV3Service,
} from "~/v3/services/batchTriggerV3.server";
import { OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";
import { extractJwtSigningSecretKey } from "~/services/realtime/jwtAuth.server";

const { action, loader } = createActionApiRoute(
  {
    headers: HeadersSchema.extend({
      "batch-processing-strategy": BatchProcessingStrategy.nullish(),
    }),
    body: BatchTriggerTaskV2RequestBody,
    allowJWT: true,
    maxContentLength: env.BATCH_TASK_PAYLOAD_MAXIMUM_SIZE,
    authorization: {
      action: "batchTrigger",
      resource: (_, __, ___, body) => ({
        tasks: Array.from(new Set(body.items.map((i) => i.task))),
      }),
      superScopes: ["write:tasks", "admin"],
    },
    corsStrategy: "all",
  },
  async ({ body, headers, params, authentication }) => {
    if (!body.items.length) {
      return json({ error: "Batch cannot be triggered with no items" }, { status: 400 });
    }

    // Check the there are fewer than MAX_BATCH_V2_TRIGGER_ITEMS items
    if (body.dependentAttempt) {
      if (body.items.length > env.MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS) {
        return json(
          {
            error: `Batch size of ${body.items.length} is too large. Maximum allowed batch size is ${env.MAX_BATCH_AND_WAIT_V2_TRIGGER_ITEMS} when batchTriggerAndWait.`,
          },
          { status: 400 }
        );
      }
    } else {
      if (body.items.length > env.MAX_BATCH_V2_TRIGGER_ITEMS) {
        return json(
          {
            error: `Batch size of ${body.items.length} is too large. Maximum allowed batch size is ${env.MAX_BATCH_V2_TRIGGER_ITEMS}.`,
          },
          { status: 400 }
        );
      }
    }

    const {
      "idempotency-key": idempotencyKey,
      "idempotency-key-ttl": idempotencyKeyTTL,
      "trigger-version": triggerVersion,
      "x-trigger-span-parent-as-link": spanParentAsLink,
      "x-trigger-worker": isFromWorker,
      "x-trigger-client": triggerClient,
      "x-trigger-engine-version": engineVersion,
      "batch-processing-strategy": batchProcessingStrategy,
      "x-trigger-realtime-streams-version": realtimeStreamsVersion,
      traceparent,
      tracestate,
    } = headers;

    const oneTimeUseToken = await getOneTimeUseToken(authentication);

    logger.debug("Batch trigger request", {
      idempotencyKey,
      idempotencyKeyTTL,
      triggerVersion,
      spanParentAsLink,
      isFromWorker,
      triggerClient,
      traceparent,
      tracestate,
      batchProcessingStrategy,
    });

    const traceContext =
      traceparent && isFromWorker // If the request is from a worker, we should pass the trace context
        ? { traceparent, tracestate }
        : undefined;

    // By default, the idempotency key expires in 30 days
    const idempotencyKeyExpiresAt =
      resolveIdempotencyKeyTTL(idempotencyKeyTTL) ??
      new Date(Date.now() + 24 * 60 * 60 * 1000 * 30);

    const service = new BatchTriggerV3Service(batchProcessingStrategy ?? undefined);

    try {
      const batch = await service.call(authentication.environment, body, {
        idempotencyKey: idempotencyKey ?? undefined,
        idempotencyKeyExpiresAt,
        triggerVersion: triggerVersion ?? undefined,
        traceContext,
        spanParentAsLink: spanParentAsLink === 1,
        oneTimeUseToken,
        realtimeStreamsVersion: determineRealtimeStreamsVersion(
          realtimeStreamsVersion ?? undefined
        ),
      });

      const $responseHeaders = await responseHeaders(
        batch,
        authentication.environment,
        triggerClient
      );

      return json(batch, { status: 202, headers: $responseHeaders });
    } catch (error) {
      logger.error("Batch trigger error", {
        error: {
          message: (error as Error).message,
          stack: (error as Error).stack,
        },
      });

      if (error instanceof ServiceValidationError) {
        return json({ error: error.message }, { status: 422 });
      } else if (error instanceof OutOfEntitlementError) {
        return json({ error: error.message }, { status: 422 });
      } else if (error instanceof Error) {
        return json(
          { error: "Something went wrong" },
          { status: 500, headers: { "x-should-retry": "false" } }
        );
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

async function responseHeaders(
  batch: BatchTriggerTaskV2Response,
  environment: AuthenticatedEnvironment,
  triggerClient?: string | null
): Promise<Record<string, string>> {
  const claimsHeader = JSON.stringify({
    sub: environment.id,
    pub: true,
  });

  if (triggerClient === "browser") {
    const claims = {
      sub: environment.id,
      pub: true,
      scopes: [`read:batch:${batch.id}`],
    };

    const jwt = await generateJWT({
      secretKey: extractJwtSigningSecretKey(environment),
      payload: claims,
      expirationTime: "1h",
    });

    return {
      "x-trigger-jwt-claims": claimsHeader,
      "x-trigger-jwt": jwt,
    };
  }

  return {
    "x-trigger-jwt-claims": claimsHeader,
  };
}

export { action, loader };
