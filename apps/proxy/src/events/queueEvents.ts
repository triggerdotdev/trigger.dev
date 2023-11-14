import { SQSClient, SendMessageBatchCommand } from "@aws-sdk/client-sqs";
import { ApiEventLog, SendBulkEventsBodySchema } from "@trigger.dev/core";
import { generateErrorMessage } from "zod-error";
import { Env } from "..";
import { getApiKeyFromRequest } from "../apikey";
import { json } from "../json";
import { calculateDeliverAt } from "./utils";

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

    const updatedEvents: ApiEventLog[] = body.data.events.map((event) => {
      const timestamp = event.timestamp ?? new Date();
      return {
        ...event,
        payload: event.payload,
        timestamp,
      };
    });

    //divide updatedEvents into multiple batches of 10 (max size SQS accepts)
    const batches: ApiEventLog[][] = [];
    let currentBatch: ApiEventLog[] = [];
    for (let i = 0; i < updatedEvents.length; i++) {
      currentBatch.push(updatedEvents[i]);
      if (currentBatch.length === 10) {
        batches.push(currentBatch);
        currentBatch = [];
      }
    }
    if (currentBatch.length > 0) {
      batches.push(currentBatch);
    }

    //loop through the batches and send them
    for (let i = 0; i < batches.length; i++) {
      const batch = batches[i];
      //add the event to the queue
      const send = new SendMessageBatchCommand({
        // use wrangler secrets to provide this global variable
        QueueUrl: env.AWS_SQS_QUEUE_URL,
        Entries: batch.map((event, index) => ({
          Id: `event-${index}`,
          MessageBody: JSON.stringify({
            event,
            options: body.data.options,
            apiKey: apiKeyResult.apiKey,
          }),
        })),
      });

      const queuedEvent = await client.send(send);
      console.log("Queued events", queuedEvent);
    }

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
    console.error("queueEvents error", e);
    return json(
      {
        error: `Failed to send events: ${e instanceof Error ? e.message : JSON.stringify(e)}`,
      },
      {
        status: 422,
      }
    );
  }
}
