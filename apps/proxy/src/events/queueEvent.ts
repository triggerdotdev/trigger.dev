import { SQSClient, SendMessageCommand } from "@aws-sdk/client-sqs";
import { ApiEventLog, SendEventBodySchema } from "@trigger.dev/core";
import { generateErrorMessage } from "zod-error";
import { Env } from "..";
import { getApiKeyFromRequest } from "../apikey";
import { json } from "../json";
import { calculateDeliverAt } from "./utils";

/** Adds the event to an AWS SQS queue, so it can be consumed from the main Trigger.dev API */
export async function queueEvent(request: Request, env: Env): Promise<Response> {
  //check there's a private API key
  const apiKeyResult = getApiKeyFromRequest(request);
  if (!apiKeyResult || apiKeyResult.type !== "PRIVATE") {
    return json(
      { error: "Invalid or Missing API key" },
      {
        status: 401,
      }
    );
  }

  //parse the request body
  try {
    const anyBody = await request.json();
    const body = SendEventBodySchema.safeParse(anyBody);
    if (!body.success) {
      return json(
        { error: generateErrorMessage(body.error.issues) },
        {
          status: 422,
        }
      );
    }

    // The AWS SDK tries to use crypto from off of the window,
    // so we need to trick it into finding it where it expects it
    globalThis.global = globalThis;

    const client = new SQSClient({
      region: env.AWS_SQS_REGION,
      credentials: {
        accessKeyId: env.AWS_SQS_ACCESS_KEY_ID,
        secretAccessKey: env.AWS_SQS_SECRET_ACCESS_KEY,
      },
    });

    const timestamp = body.data.event.timestamp ?? new Date();

    //add the event to the queue
    const send = new SendMessageCommand({
      // use wrangler secrets to provide this global variable
      QueueUrl: env.AWS_SQS_QUEUE_URL,
      MessageBody: JSON.stringify({
        event: { ...body.data.event, timestamp },
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
      timestamp,
      deliverAt: calculateDeliverAt(body.data.options),
    };

    return json(event, {
      status: 200,
    });
  } catch (e) {
    console.error("queueEvent error", e);
    return json(
      {
        error: `Failed to send event: ${e instanceof Error ? e.message : JSON.stringify(e)}`,
      },
      {
        status: 422,
      }
    );
  }
}
