import type { ActionFunctionArgs } from "@remix-run/server-runtime";
import { json } from "@remix-run/server-runtime";
import { TriggerTaskRequestBody } from "@trigger.dev/core/v3";
import { z } from "zod";
import { env } from "~/env.server";
import { authenticateApiRequest } from "~/services/apiAuth.server";
import { logger } from "~/services/logger.server";
import { parseRequestJsonAsync } from "~/utils/parseRequestJson.server";
import { ServiceValidationError } from "~/v3/services/baseService.server";
import { OutOfEntitlementError, TriggerTaskService } from "~/v3/services/triggerTask.server";
import { startActiveSpan } from "~/v3/tracer.server";

const ParamsSchema = z.object({
  taskId: z.string(),
});

export const HeadersSchema = z.object({
  "idempotency-key": z.string().nullish(),
  "trigger-version": z.string().nullish(),
  "x-trigger-span-parent-as-link": z.coerce.number().nullish(),
  "x-trigger-worker": z.string().nullish(),
  traceparent: z.string().optional(),
  tracestate: z.string().optional(),
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

  const contentLength = request.headers.get("content-length");

  if (!contentLength || parseInt(contentLength) > env.TASK_PAYLOAD_MAXIMUM_SIZE) {
    return json({ error: "Request body too large" }, { status: 413 });
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
    "x-trigger-worker": isFromWorker,
  } = headers.data;

  const { taskId } = ParamsSchema.parse(params);

  // Now parse the request body
  const anyBody = await parseRequestJsonAsync(request, { taskId });

  const body = await startActiveSpan("TriggerTaskRequestBody.safeParse()", async (span) => {
    return TriggerTaskRequestBody.safeParse(anyBody);
  });

  if (!body.success) {
    return json({ error: "Invalid request body" }, { status: 400 });
  }

  const service = new TriggerTaskService();

  try {
    const traceContext = traceparent
      ? !triggerVersion // If the trigger version is NOT set, we are in an older version of the SDK
        ? { traceparent, tracestate }
        : isFromWorker // If the trigger version is set, and the request is from a worker, we should pass the trace context
        ? { traceparent, tracestate }
        : undefined
      : undefined;

    logger.debug("Triggering task", {
      taskId,
      idempotencyKey,
      triggerVersion,
      headers: Object.fromEntries(request.headers),
      options: body.data.options,
      isFromWorker,
      traceContext,
    });

    const run = await service.call(taskId, authenticationResult.environment, body.data, {
      idempotencyKey: idempotencyKey ?? undefined,
      triggerVersion: triggerVersion ?? undefined,
      traceContext,
      spanParentAsLink: spanParentAsLink === 1,
    });

    if (!run) {
      return json({ error: "Task not found" }, { status: 404 });
    }

    return json({
      id: run.friendlyId,
    });
  } catch (error) {
    if (error instanceof ServiceValidationError) {
      return json({ error: error.message }, { status: 422 });
    } else if (error instanceof OutOfEntitlementError) {
      return json({ error: error.message }, { status: 422 });
    } else if (error instanceof Error) {
      return json({ error: error.message }, { status: 400 });
    }

    return json({ error: "Something went wrong" }, { status: 500 });
  }
}
