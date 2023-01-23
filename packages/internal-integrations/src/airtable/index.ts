import { ulid } from "ulid";
import {
  AccessInfo,
  DisplayProperty,
  HandleWebhookOptions,
  WebhookConfig,
  WebhookIntegration,
} from "../types";
import { z } from "zod";
import { airtable } from "@trigger.dev/providers";
import { getAccessToken } from "../accessInfo";
import crypto from "crypto";

export class AirtableWebhookIntegration implements WebhookIntegration {
  keyForSource(source: unknown): string {
    const airtableSource = parseWebhookSource(source);
    return `base.${airtableSource.baseId}.${airtableSource.events.join(".")}`;
  }

  registerWebhook(config: WebhookConfig, source: unknown) {
    const airtableSource = parseWebhookSource(source);
    return registerWebhook(config, airtableSource);
  }

  async handleWebhookRequest(options: HandleWebhookOptions) {
    const contentHash = options.request.headers["x-airtable-content-mac"];

    //todo – add webhook verification
    // if (options.secret && contentHash) {
    //   //Extract Signature header
    //   const sig = Buffer.from(contentHash || "", "utf8");

    //   //Calculate HMAC
    //   const hmac = crypto.createHmac("sha256", options.secret);
    //   //create raw body from javascript object options.request.body

    //   const rawBody = Buffer.from(
    //     JSON.stringify(options.request.body)
    //   ).toString("utf8");
    //   const digest = Buffer.from(hmac.update(rawBody).digest("hex"), "utf8");

    //   //Compare HMACs
    //   if (
    //     sig.length !== digest.length ||
    //     !crypto.timingSafeEqual(digest, sig)
    //   ) {
    //     return {
    //       status: "error" as const,
    //       error: `AirtableWebhookIntegration: Could not verify webhook payload, invalid signature or secret`,
    //     };
    //   }
    // }

    const context = omit(options.request.headers, [
      "x-airtable-content-mac",
      "content-type",
      "content-length",
      "accept",
      "accept-encoding",
    ]);

    const baseId = options.request.body.base.id;
    const webhookId = options.request.body.webhook.id;
    const accessToken = getAccessToken(options.accessInfo);
    const latestTriggerEvent = options.options?.latestTriggerEvent;
    const payloads = await getPayloads({
      baseId,
      webhookId,
      accessToken,
      latestTriggerEventId: latestTriggerEvent?.id,
    });

    //create the payload, combining the webhook payload with the actual payloads
    type AllEvent = z.infer<typeof airtable.schemas.allEventSchema>;
    const allEvent: AllEvent = {
      base: {
        id: baseId,
      },
      payloads: payloads ?? [],
    };

    return {
      status: "ok" as const,
      data: payloads.map((p) => ({
        id: triggerEventId({
          baseId,
          webhookId,
          cursor: p.baseTransactionNumber,
        }),
        payload: {
          base: {
            id: baseId,
          },
          ...p,
        },
        event: "all",
        context,
      })),
    };
  }

  displayProperties(source: unknown) {
    const airtableSource = parseWebhookSource(source);

    const title = `Airtable`;
    let properties: DisplayProperty[] = [];

    return { title, properties };
  }
}

export const webhooks = new AirtableWebhookIntegration();

async function registerWebhook(
  config: WebhookConfig,
  source: z.infer<typeof airtable.schemas.WebhookSourceSchema>
) {
  const response = await fetch(
    `https://api.airtable.com/v0/bases/${source.baseId}/webhooks`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${getAccessToken(config.accessInfo)}`,
      },
      body: JSON.stringify({
        notificationUrl: config.callbackUrl,
        specification: {
          options: {
            filters: {
              dataTypes: ["tableData", "tableFields", "tableMetadata"],
            },
            includes: {
              includePreviousCellValues: true,
              includePreviousFieldDefinitions: true,
            },
          },
        },
      }),
    }
  );

  if (!response.ok) {
    if (response.status === 404) {
      throw new Error(
        `Failed to register webhook: Airtable base ${source.baseId} not found`
      );
    }

    const existingWebhooksList = await fetch(
      `https://api.airtable.com/v0/bases/${source.baseId}/webhooks`,
      {
        method: "GET",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${getAccessToken(config.accessInfo)}`,
        },
      }
    );

    if (existingWebhooksList.ok) {
      const existingJson = await existingWebhooksList.json();

      if (existingJson.webhooks.length >= 2) {
        throw new Error(
          `Failed to register webhook: Airtable base ${source.baseId} already has ${existingJson.webhooks.length} webhooks`
        );
      }
    }

    throw new Error(`Failed to register webhook: ${response.statusText}`);
  }

  const webhook = await response.json();

  return webhook;
}

type Payload = z.infer<typeof airtable.schemas.payloadSchema>;

async function getPayloads({
  baseId,
  webhookId,
  accessToken,
  latestTriggerEventId,
}: {
  baseId: string;
  webhookId: string;
  accessToken: string;
  latestTriggerEventId?: string | null;
}) {
  let cursor = 1;
  if (latestTriggerEventId) {
    cursor = parseInt(latestTriggerEventId.split(":")[1]);
  }

  let getMore = true;
  let allPayloads: Payload[] = [];
  while (getMore) {
    const payloads = await getPayload({
      baseId,
      webhookId,
      accessToken,
      cursor,
    });

    allPayloads.push(...payloads.payloads);

    if (payloads.mightHaveMore === false) {
      return allPayloads;
    } else {
      cursor = payloads.cursor;
    }
  }

  return allPayloads;
}

async function getPayload({
  baseId,
  webhookId,
  accessToken,
  cursor,
}: {
  baseId: string;
  webhookId: string;
  accessToken: string;
  cursor: number;
}) {
  const payloads = await fetch(
    `https://api.airtable.com/v0/bases/${baseId}/webhooks/${webhookId}/payloads?limit=50&cursor=${cursor}
  `,
    {
      method: "GET",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${accessToken}`,
      },
    }
  );

  if (!payloads.ok) {
    throw {
      status: "error" as const,
      error: `AirtableWebhookIntegration: Could not fetch payloads for webhook. \nbaseId: ${baseId}, webhookId: ${webhookId}\nerror: ${payloads.statusText}`,
    };
  }

  const payloadsJson = await payloads.json();
  return airtable.schemas.WebhookPayloadListSchema.parse(payloadsJson);
}

function triggerEventId({
  baseId,
  webhookId,
  cursor,
}: {
  baseId: string;
  webhookId: string;
  cursor: number;
}) {
  return `${baseId}-${webhookId}:${cursor}`;
}

function parseWebhookSource(source: unknown) {
  return airtable.schemas.WebhookSourceSchema.parse(source);
}

function omit<T extends Record<string, unknown>, K extends keyof T>(
  obj: T,
  keys: K[]
): Omit<T, K> {
  const result: any = {};

  for (const key of Object.keys(obj)) {
    if (!keys.includes(key as K)) {
      result[key] = obj[key];
    }
  }

  return result;
}
