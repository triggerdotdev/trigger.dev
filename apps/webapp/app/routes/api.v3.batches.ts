import { json } from "@remix-run/server-runtime";
import { CreateBatchRequestBody, CreateBatchResponse, generateJWT } from "@trigger.dev/core/v3";
import { prisma } from "~/db.server";
import { env } from "~/env.server";
import { BatchRateLimitExceededError } from "~/runEngine/concerns/batchLimits.server";
import { CreateBatchService } from "~/runEngine/services/createBatch.server";
import { AuthenticatedEnvironment, getOneTimeUseToken } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import {
  handleRequestIdempotency,
  saveRequestIdempotency,
} from "~/utils/requestIdempotency.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";
import { extractJwtSigningSecretKey } from "~/services/realtime/jwtAuth.server";
import { engine } from "~/v3/runEngine.server";

/**
 * Phase 1 of 2-phase batch API: Create a batch.
 *
 * POST /api/v3/batches
 *
 * Creates a batch record and optionally blocks the parent run for batchTriggerAndWait.
 * Items are streamed separately via POST /api/v3/batches/:batchId/items
 */
const { action, loader } = createActionApiRoute(
  {
    headers: HeadersSchema,
    body: CreateBatchRequestBody,
    allowJWT: true,
    maxContentLength: 65_536, // 64KB is plenty for the batch metadata
    authorization: {
      action: "batchTrigger",
      resource: () => ({
        // No specific tasks to authorize at batch creation time
        // Tasks are validated when items are streamed
        tasks: [],
      }),
      superScopes: ["write:tasks", "admin"],
    },
    corsStrategy: "all",
  },
  async ({ body, headers, authentication }) => {
    // Validate runCount
    if (body.runCount <= 0) {
      return json({ error: "runCount must be a positive integer" }, { status: 400 });
    }

    // Check runCount against limit
    if (body.runCount > env.STREAMING_BATCH_MAX_ITEMS) {
      return json(
        {
          error: `Batch runCount of ${body.runCount} exceeds maximum allowed of ${env.STREAMING_BATCH_MAX_ITEMS}.`,
        },
        { status: 400 }
      );
    }

    // Verify BatchQueue is enabled
    if (!engine.isBatchQueueEnabled()) {
      return json(
        {
          error: "Streaming batch API is not available. BatchQueue is not enabled.",
        },
        { status: 503 }
      );
    }

    const {
      "trigger-version": triggerVersion,
      "x-trigger-span-parent-as-link": spanParentAsLink,
      "x-trigger-worker": isFromWorker,
      "x-trigger-client": triggerClient,
      "x-trigger-realtime-streams-version": realtimeStreamsVersion,
      traceparent,
      tracestate,
    } = headers;

    const oneTimeUseToken = await getOneTimeUseToken(authentication);

    logger.debug("Create batch request", {
      runCount: body.runCount,
      parentRunId: body.parentRunId,
      resumeParentOnCompletion: body.resumeParentOnCompletion,
      idempotencyKey: body.idempotencyKey,
      triggerVersion,
      isFromWorker,
      triggerClient,
    });

    // Handle idempotency for the batch creation
    const cachedResponse = await handleRequestIdempotency<
      { friendlyId: string; runCount: number },
      CreateBatchResponse
    >(body.idempotencyKey, {
      requestType: "create-batch",
      findCachedEntity: async (cachedRequestId) => {
        return await prisma.batchTaskRun.findFirst({
          where: {
            id: cachedRequestId,
            runtimeEnvironmentId: authentication.environment.id,
          },
          select: {
            friendlyId: true,
            runCount: true,
          },
        });
      },
      buildResponse: (cachedBatch) => ({
        id: cachedBatch.friendlyId,
        runCount: cachedBatch.runCount,
        isCached: true,
      }),
      buildResponseHeaders: async (responseBody) => {
        return await responseHeaders(responseBody, authentication.environment, triggerClient);
      },
    });

    if (cachedResponse) {
      return cachedResponse;
    }

    const traceContext = isFromWorker
      ? { traceparent, tracestate }
      : { external: { traceparent, tracestate } };

    const service = new CreateBatchService();

    service.onBatchTaskRunCreated.attachOnce(async (batch) => {
      await saveRequestIdempotency(body.idempotencyKey, "create-batch", batch.id);
    });

    try {
      const batch = await service.call(authentication.environment, body, {
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

      return json(batch, {
        status: 202,
        headers: $responseHeaders,
      });
    } catch (error) {
      if (error instanceof BatchRateLimitExceededError) {
        logger.info("Batch rate limit exceeded", {
          limit: error.limit,
          remaining: error.remaining,
          resetAt: error.resetAt.toISOString(),
          itemCount: error.itemCount,
        });
        return json(
          { error: error.message },
          {
            status: 429,
            headers: {
              "X-RateLimit-Limit": error.limit.toString(),
              "X-RateLimit-Remaining": error.remaining.toString(),
              "X-RateLimit-Reset": Math.floor(error.resetAt.getTime() / 1000).toString(),
              "Retry-After": Math.max(
                1,
                Math.ceil((error.resetAt.getTime() - Date.now()) / 1000)
              ).toString(),
            },
          }
        );
      }

      logger.error("Create batch error", {
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
          { error: error.message },
          { status: 500, headers: { "x-should-retry": "false" } }
        );
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

async function responseHeaders(
  batch: CreateBatchResponse,
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
      scopes: [`read:batch:${batch.id}`, `write:batch:${batch.id}`],
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
