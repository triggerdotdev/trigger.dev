import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiEventLog, SendEventBodySchema, SendEventOptions } from "@trigger.dev/core";
import { generateErrorMessage } from "zod-error";
import { getApiKeyFromRequest } from "./apikey";
import { Env } from ".";

/** Adds the event to an AWS SQS queue, so it can be consumed from the main Trigger.dev API */
export async function queueEvent(request: Request, env: Env): Promise<Response> {
  //check there's a private API key
  const apiKeyResult = getApiKeyFromRequest(request);
  if (!apiKeyResult || apiKeyResult.type !== "PRIVATE") {
    return new Response(JSON.stringify({ error: "Invalid or Missing API key" }), {
      status: 401,
      headers: { "content-type": "application/json" },
    });
  }

  //parse the request body
  try {
    const anyBody = await request.json();
    const body = SendEventBodySchema.safeParse(anyBody);
    if (!body.success) {
      return new Response(JSON.stringify({ message: generateErrorMessage(body.error.issues) }), {
        status: 422,
        headers: { "content-type": "application/json" },
      });
    }

    // The AWS SDK tries to use crypto from off of the window,
    // so we need to trick it into finding it where it expects it
    globalThis.global = globalThis;
    //@ts-ignore
    global.window = {};
    //@ts-ignore
    window.crypto = crypto;

    const client = new SQSClient({
      region: env.AWS_SQS_REGION,
      credentials: {
        accessKeyId: env.AWS_SQS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SQS_SECRET_ACCESS_KEY,
      },
    });

    //add the event to the queue
    const send = new SendMessageCommand({
      // use wrangler secrets to provide this global variable
      QueueUrl: env.AWS_SQS_QUEUE_URL,
      MessageBody: JSON.stringify({
        event: body.data.event,
        options: body.data.options,
        apiKey: apiKeyResult.apiKey,
      }),
    });

    const queuedEvent = await client.send(send);
    console.log("Queued event", queuedEvent);

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
  } catch (e) {
    return new Response(
      JSON.stringify({
        message: `Failed to parse event body: ${
          e instanceof Error ? e.message : JSON.stringify(e)
        }`,
      }),
      {
        status: 422,
        headers: { "content-type": "application/json" },
      }
    );
  }
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
