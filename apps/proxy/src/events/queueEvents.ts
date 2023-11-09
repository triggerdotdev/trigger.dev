import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import {
  ApiEventLog,
  SendBulkEventsBodySchema,
  SendEventBodySchema,
  SendEventOptions,
} from "@trigger.dev/core";
import { generateErrorMessage } from "zod-error";
import { getApiKeyFromRequest } from "../apikey";
import { Env } from "..";
import { calculateDeliverAt } from "./utils";
import { json } from "../json";

/** Adds the event to an AWS SQS queue, so it can be consumed from the main Trigger.dev API */
export async function queueEvents(request: Request, env: Env): Promise<Response> {
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
    const body = SendBulkEventsBodySchema.safeParse(anyBody);
    if (!body.success) {
      return json(
        { message: generateErrorMessage(body.error.issues) },
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

    const updatedEvents = body.data.events.map((event) => {
      const timestamp = event.timestamp ?? new Date();
      return {
        ...event,
        timestamp,
      };
    });

    //add the event to the queue
    const send = new SendMessageBatchCommand({
      // use wrangler secrets to provide this global variable
      QueueUrl: env.AWS_SQS_QUEUE_URL,
      Entries: updatedEvents.map((event) => ({
        Id: event.id,
        MessageBody: JSON.stringify({
          event,
          options: body.data.options,
          apiKey: apiKeyResult.apiKey,
        }),
      })),
    });

    const queuedEvent = await client.send(send);
    console.log("Queued event", queuedEvent);

    //respond with the events
    const events: ApiEventLog[] = updatedEvents.map((event) => ({
      ...event,
      payload: event.payload,
      deliverAt: calculateDeliverAt(body.data.options),
    }));

    return json(events, {
      status: 200,
    });
  } catch (e) {
    return json(
      {
        message: `Failed to parse event body: ${
          e instanceof Error ? e.message : JSON.stringify(e)
        }`,
      },
      {
        status: 422,
      }
    );
  }
}
