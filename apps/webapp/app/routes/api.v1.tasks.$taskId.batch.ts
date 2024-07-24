import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { BatchTriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { MAX_BATCH_TRIGGER_ITEMS } from "~/consts";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { BatchTriggerTaskService } from "~/v3/services/batchTriggerTask.server";
import { HeadersSchema } from "./api.v1.tasks.$taskId.trigger";
import { env } from "~/env.server";
import { fromZodError } from "zod-validation-error";

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

  const service = new BatchTriggerTaskService();

  try {
    const result = await service.call(taskId, authenticationResult.environment, body.data, {
      idempotencyKey: idempotencyKey ?? undefined,
      triggerVersion: triggerVersion ?? undefined,
      traceContext: traceparent ? { traceparent, tracestate } : undefined,
      spanParentAsLink: spanParentAsLink === 1,
    });

    if (!result) {
      return json({ error: "Task not found" }, { status: 404 });
    }

    return json({
      batchId: result.batch.friendlyId,
      runs: result.runs,
    });
  } catch (error) {
    if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
