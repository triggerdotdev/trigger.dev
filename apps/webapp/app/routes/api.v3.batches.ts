import { json } from "@remix-run/server-runtime";
import type { CreateBatchResponse } from "@trigger.dev/core/v3";
import { CreateBatchRequestBody, generateJWT } from "@trigger.dev/core/v3";
import { env } from "~/env.server";
import { BatchRateLimitExceededError } from "~/runEngine/concerns/batchLimits.server";
import { CreateBatchService } from "~/runEngine/services/createBatch.server";
import type { AuthenticatedEnvironment } from "~/services/apiAuth.server";
import type { RbacAbility } from "@trigger.dev/rbac";
import { getOneTimeUseToken } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { extractJwtSigningSecretKey } from "~/services/realtime/jwtAuth.server";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";
import {
  anyResource,
  createActionApiRoute,
  everyResource,
} from "~/services/routeBuilders/apiBuilder.server";
import { batchPublicAccessScopes } from "~/utils/batchItemAuthorization";
import { canWriteParentRun } from "~/utils/parentRunAuthorization.server";
import { clientSafeErrorMessage } from "~/utils/prismaErrors";
import {
  handleRequestIdempotency,
  saveRequestIdempotency,
} from "~/utils/requestIdempotency.server";
import { scopeRequestIdempotencyKey } from "~/utils/requestIdempotencyKey";
import { sanitizeTriggerSource } from "~/utils/triggerSource";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { OutOfEntitlementError } from "~/v3/services/triggerTask.server";
import { engine } from "~/v3/runEngine.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";

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
    maxContentLength: 131_072, // 128KB is plenty for the batch metadata
    authorization: {
      action: "batchTrigger",
      resource: (_params, _searchParams, _headers, body) => {
        // Newer clients declare the distinct task identifiers before creating
        // the batch, so selected-task credentials can be authorized before the
        // shell is created. Older clients omit them and retain the existing
        // collection-level behavior: broad credentials pass, selected-task
        // credentials fail closed.
        if (!body.taskIdentifiers) {
          return anyResource([{ type: "batch" }, { type: "tasks" }]);
        }

        return everyResource(
          body.taskIdentifiers.map((id) => ({ type: "tasks" as const, id })),
          [{ type: "batch" }, { type: "tasks" }]
        );
      },
    },
    corsStrategy: "all",
  },
  async ({ body, headers, authentication, ability }) => {
    // Validate runCount
    if (body.runCount <= 0) {
      return json({ error: "runCount must be a positive integer" }, { status: 400 });
    }

    if (
      !(await canWriteParentRun(
        ability,
        authentication.environment.id,
        authentication.environment.organizationId,
        body.parentRunId
      ))
    ) {
      return json({ error: "Unauthorized" }, { status: 403 });
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

    const {
      "trigger-version": triggerVersion,
      "x-trigger-span-parent-as-link": spanParentAsLink,
      "x-trigger-worker": isFromWorker,
      "x-trigger-client": triggerClient,
      "x-trigger-realtime-streams-version": realtimeStreamsVersion,
      "x-trigger-source": triggerSourceHeader,
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

    // Keep create-batch retries isolated by environment and the task set that
    // was authorized above. Sorting makes the scope stable when callers send
    // the same identifiers in a different order.
    const scopedIdempotencyKey = scopeRequestIdempotencyKey(body.idempotencyKey, [
      authentication.environment.id,
      ...(body.taskIdentifiers ? [...new Set(body.taskIdentifiers)].sort() : []),
    ]);

    const cachedResponse = await handleRequestIdempotency<
      { friendlyId: string; runCount: number },
      CreateBatchResponse
    >(scopedIdempotencyKey, {
      requestType: "create-batch",
      findCachedEntity: async (cachedRequestId) => {
        const batch = await engine.runStore.findBatchTaskRunById(cachedRequestId);
        if (!batch || batch.runtimeEnvironmentId !== authentication.environment.id) return null;
        return batch;
      },
      buildResponse: (cachedBatch) => ({
        id: cachedBatch.friendlyId,
        runCount: cachedBatch.runCount,
        isCached: true,
      }),
      buildResponseHeaders: async (responseBody) => {
        return await responseHeaders(
          responseBody,
          authentication.environment,
          ability,
          triggerClient
        );
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
      await saveRequestIdempotency(scopedIdempotencyKey, "create-batch", batch.id);
    });

    try {
      const batch = await service.call(authentication.environment, body, {
        triggerVersion: triggerVersion ?? undefined,
        traceContext,
        spanParentAsLink: spanParentAsLink === 1,
        oneTimeUseToken,
        realtimeStreamsVersion: determineRealtimeStreamsVersion(
          realtimeStreamsVersion ?? undefined,
          authentication.environment.organization.streamBasinName
        ),
        triggerSource: isFromWorker ? "sdk" : (sanitizeTriggerSource(triggerSourceHeader) ?? "api"),
      });

      const $responseHeaders = await responseHeaders(
        batch,
        authentication.environment,
        ability,
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
              "X-RateLimit-Remaining": Math.max(0, error.remaining).toString(),
              "X-RateLimit-Reset": Math.floor(error.resetAt.getTime() / 1000).toString(),
              "Retry-After": Math.max(
                1,
                Math.ceil((error.resetAt.getTime() - Date.now()) / 1000)
              ).toString(),
            },
          }
        );
      }

      // Customer-facing validation/quota failures (invalid batch shape,
      // entitlements exhausted). The handler returns 422 with the message;
      // system handles it gracefully, no alert needed.
      if (error instanceof ServiceValidationError) {
        logger.warn("Create batch error", { error: error.message });
        return json({ error: error.message }, { status: error.status ?? 422 });
      }
      if (error instanceof OutOfEntitlementError) {
        logger.warn("Create batch error", { error: error.message });
        return json({ error: error.message }, { status: 422 });
      }

      logger.error("Create batch error", {
        error: {
          message: (error as Error).message,
          stack: (error as Error).stack,
        },
      });

      if (error instanceof Error) {
        return json(
          { error: clientSafeErrorMessage(error) },
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
  ability: RbacAbility,
  triggerClient?: string | null
): Promise<Record<string, string>> {
  // Browser clients need a delegated token for phase two because they must not
  // retain a private API key. Selected-task credentials only receive read access
  // and must continue to authorize each streamed item with their private key.
  const scopes = batchPublicAccessScopes(batch.id, ability, triggerClient === "browser");

  const jwt = await generateJWT({
    secretKey: extractJwtSigningSecretKey(environment),
    payload: {
      sub: environment.id,
      pub: true,
      scopes,
    },
    expirationTime: "1h",
  });

  return {
    "x-trigger-jwt-claims": JSON.stringify({ sub: environment.id, pub: true }),
    "x-trigger-jwt": jwt,
  };
}

export { action, loader };
