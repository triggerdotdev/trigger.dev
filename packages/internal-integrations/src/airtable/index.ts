import { ulid } from "ulid";
import {
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

  handleWebhookRequest(options: HandleWebhookOptions) {
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

    return {
      status: "ok" as const,
      data: {
        id: ulid(),
        payload: options.request.body,
        event: "all",
        context,
      },
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
