import { ApiEventLog, SendEventBodySchema, SendEventOptions } from "@trigger.dev/core";
import { getApiKeyFromRequest } from "./apikey";
import { generateErrorMessage } from "zod-error";

/** Adds the event to an AWS SQS queue, so it can be consumed from the main Trigger.dev API */
export async function queueEvent(request: Request): Promise<Response> {
  //check there's a private API key
  const apiKeyResult = getApiKeyFromRequest(request);
  if (!apiKeyResult || apiKeyResult.type !== "PRIVATE") {
    return new Response(JSON.stringify({ error: "Invalid or Missing API key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  //parse the request body
  const anyBody = await request.json();
  const body = SendEventBodySchema.safeParse(anyBody);
  if (!body.success) {
    return new Response(JSON.stringify({ message: generateErrorMessage(body.error.issues) }), {
      status: 422,
      headers: { "content-type": "application/json" },
    });
  }

  //add the event to the queue

  //respond with the event
  const event: ApiEventLog = {
    id: body.data.event.id,
    name: body.data.event.name,
    payload: body.data.event.payload,
    context: body.data.event.context,
    timestamp: body.data.event.timestamp ?? new Date(),
    deliverAt: calculateDeliverAt(body.data.options),
  };

  return new Response(JSON.stringify(event), {
    status: 200,
    headers: { "content-type": "application/json" },
  });
}

function calculateDeliverAt(options?: SendEventOptions) {
  // If deliverAt is a string and a valid date, convert it to a Date object
  if (options?.deliverAt) {
    return options?.deliverAt;
  }

  // deliverAfter is the number of seconds to wait before delivering the event
  if (options?.deliverAfter) {
    return new Date(Date.now() + options.deliverAfter * 1000);
  }

  return undefined;
}
