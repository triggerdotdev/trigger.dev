import { json } from "@remix-run/server-runtime";
import type { BatchTriggerTaskV2RequestBody } from "@trigger.dev/core/v3";
import { BatchTriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { MAX_BATCH_TRIGGER_ITEMS } from "~/consts";
import { canWriteParentRun } from "~/utils/parentRunAuthorization.server";
import { clientSafeErrorMessage } from "~/utils/prismaErrors";
import { env } from "~/env.server";
import { logger } from "~/services/logger.server";
import { createActionApiRoute } from "~/services/routeBuilders/apiBuilder.server";
import { BatchTriggerV3Service } from "~/v3/services/batchTriggerV3.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";
import { publicAccessTokenResponseHeaders } from "~/services/publicAccessTokenResponse.server";

const ParamsSchema = z.object({
  taskId: z.string(),
});

const { action } = createActionApiRoute(
  {
    params: ParamsSchema,
    headers: HeadersSchema,
    body: BatchTriggerTaskRequestBody,
    method: "POST",
    maxContentLength: env.TASK_PAYLOAD_MAXIMUM_SIZE,
    authorization: {
      action: "batchTrigger",
      resource: (params) => ({ type: "tasks", id: params.taskId }),
    },
  },
  async ({ params, headers, body, authentication, ability }) => {
    const { taskId } = params;
    const {
      "idempotency-key": idempotencyKey,
      "trigger-version": triggerVersion,
      "x-trigger-span-parent-as-link": spanParentAsLink,
      "x-trigger-worker": isFromWorker,
      "x-trigger-realtime-streams-version": realtimeStreamsVersion,
      traceparent,
      tracestate,
    } = headers;

    logger.debug("Triggering batch", {
      taskId,
      idempotencyKey,
      triggerVersion,
      body,
    });

    if (!body.items.length) {
      return json({ error: "No items to trigger" }, { status: 400 });
    }

    // Check the there are fewer than 100 items. This has to stay above the
    // parent-run authorization below, which costs one lookup per distinct
    // parent — an oversized batch must be rejected before it can spend them.
    if (body.items.length > MAX_BATCH_TRIGGER_ITEMS) {
      return json(
        {
          error: `Too many items. Maximum allowed batch size is ${MAX_BATCH_TRIGGER_ITEMS}.`,
        },
        { status: 400 }
      );
    }

    const parentRunIds = Array.from(
      new Set(body.items.map((item) => item.options?.parentRunId).filter((id) => id !== undefined))
    );
    const canWriteParentRuns = await Promise.all(
      parentRunIds.map((parentRunId) =>
        canWriteParentRun(
          ability,
          authentication.environment.id,
          authentication.environment.organizationId,
          parentRunId
        )
      )
    );
    if (canWriteParentRuns.some((allowed) => !allowed)) {
      return json({ error: "Unauthorized" }, { status: 403 });
    }

    const service = new BatchTriggerV3Service();

    const traceContext =
      traceparent && isFromWorker // If the request is from a worker, we should pass the trace context
        ? { traceparent, tracestate }
        : undefined;

    const v3Body = convertV1BodyToV2Body(body, taskId);

    try {
      const result = await service.call(authentication.environment, v3Body, {
        idempotencyKey: idempotencyKey ?? undefined,
        triggerVersion: triggerVersion ?? undefined,
        traceContext,
        spanParentAsLink: spanParentAsLink === 1,
        realtimeStreamsVersion: determineRealtimeStreamsVersion(
          realtimeStreamsVersion ?? undefined,
          authentication.environment.organization.streamBasinName
        ),
      });

      if (!result) {
        return json({ error: "Task not found" }, { status: 404 });
      }

      const $responseHeaders = await publicAccessTokenResponseHeaders({
        environment: authentication.environment,
        scopes: [`read:batch:${result.id}`],
        expirationTime: "1h",
      });

      return json(
        {
          batchId: result.id,
          runs: result.runs.map((run) => run.id),
        },
        { headers: $responseHeaders }
      );
    } catch (error) {
      if (error instanceof Error) {
        return json({ error: clientSafeErrorMessage(error) }, { status: 400 });
      }

      return json({ error: "Something went wrong" }, { status: 500 });
    }
  }
);

export { action };

// Strip from options:
// - dependentBatch
// - dependentAttempt
// - parentBatch
function convertV1BodyToV2Body(
  body: BatchTriggerTaskRequestBody,
  taskIdentifier: string
): BatchTriggerTaskV2RequestBody {
  return {
    items: body.items.map((item) => ({
      task: taskIdentifier,
      payload: item.payload,
      context: item.context,
      options: item.options
        ? {
            ...item.options,
            dependentBatch: undefined,
            parentBatch: undefined,
            dependentAttempt: undefined,
          }
        : undefined,
    })),
    dependentAttempt: body.dependentAttempt,
  };
}
