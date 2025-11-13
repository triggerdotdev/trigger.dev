import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { BatchTriggerTaskRequestBody, BatchTriggerTaskV2RequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { fromZodError } from "zod-validation-error";
import { MAX_BATCH_TRIGGER_ITEMS } from "~/consts";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BatchTriggerV3Service } from "~/v3/services/batchTriggerV3.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";
import { determineRealtimeStreamsVersion } from "~/services/realtime/v1StreamsGlobal.server";

const ParamsSchema = z.object({
  taskId: z.string(),
});

export async function action({ request, params }: ActionFunctionArgs) {
  // Ensure this is a POST request
  if (request.method.toUpperCase() !== "POST") {
    return { status: 405, body: "Method Not Allowed" };
  }

  // Next authenticate the request
  const authenticationResult = await authenticateApiRequest(request);

  if (!authenticationResult) {
    return json({ error: "Invalid or Missing API key" }, { status: 401 });
  }

  const rawHeaders = Object.fromEntries(request.headers);

  const headers = HeadersSchema.safeParse(rawHeaders);

  if (!headers.success) {
    return json({ error: "Invalid headers" }, { status: 400 });
  }

  const {
    "idempotency-key": idempotencyKey,
    "trigger-version": triggerVersion,
    "x-trigger-span-parent-as-link": spanParentAsLink,
    "x-trigger-worker": isFromWorker,
    "x-trigger-realtime-streams-version": realtimeStreamsVersion,
    traceparent,
    tracestate,
  } = headers.data;

  const { taskId } = ParamsSchema.parse(params);

  const contentLength = request.headers.get("content-length");

  if (!contentLength || parseInt(contentLength) > env.TASK_PAYLOAD_MAXIMUM_SIZE) {
    return json({ error: "Request body too large" }, { status: 413 });
  }

  // Now parse the request body
  const anyBody = await request.json();

  const body = BatchTriggerTaskRequestBody.safeParse(anyBody);

  if (!body.success) {
    return json(
      { error: fromZodError(body.error, { prefix: "Invalid batchTrigger call" }).toString() },
      { status: 400 }
    );
  }

  logger.debug("Triggering batch", {
    taskId,
    idempotencyKey,
    triggerVersion,
    body: body.data,
  });

  if (!body.data.items.length) {
    return json({ error: "No items to trigger" }, { status: 400 });
  }

  // Check the there are fewer than 100 items
  if (body.data.items.length > MAX_BATCH_TRIGGER_ITEMS) {
    return json(
      {
        error: `Too many items. Maximum allowed batch size is ${MAX_BATCH_TRIGGER_ITEMS}.`,
      },
      { status: 400 }
    );
  }

  const service = new BatchTriggerV3Service();

  const traceContext =
    traceparent && isFromWorker // If the request is from a worker, we should pass the trace context
      ? { traceparent, tracestate }
      : undefined;

  const v3Body = convertV1BodyToV2Body(body.data, taskId);

  try {
    const result = await service.call(authenticationResult.environment, v3Body, {
      idempotencyKey: idempotencyKey ?? undefined,
      triggerVersion: triggerVersion ?? undefined,
      traceContext,
      spanParentAsLink: spanParentAsLink === 1,
      realtimeStreamsVersion: determineRealtimeStreamsVersion(realtimeStreamsVersion ?? undefined),
    });

    if (!result) {
      return json({ error: "Task not found" }, { status: 404 });
    }

    return json(
      {
        batchId: result.id,
        runs: result.runs.map((run) => run.id),
      },
      {
        headers: {
          "x-trigger-jwt-claims": JSON.stringify({
            sub: authenticationResult.environment.id,
            pub: true,
          }),
        },
      }
    );
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}

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
