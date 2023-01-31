import crypto from "crypto";
import { ulid } from "ulid";
import { getAccessToken } from "@trigger.dev/integration-sdk";
import type {
  DisplayProperty,
  HandleWebhookOptions,
  WebhookConfig,
  WebhookIntegration,
} from "@trigger.dev/integration-sdk";
import { WebhookSourceSchema } from "../schemas";

export class WhatsAppWebhookIntegration implements WebhookIntegration {
  keyForSource(source: unknown): string {
    const whatsAppSource = parseWebhookSource(source);

    switch (whatsAppSource.subresource) {
      case "messages":
        return `messages.${
          whatsAppSource.accountId
        }.${whatsAppSource.events.join(".")}`;
      default:
        throw new Error(`Unknown subresource`);
    }
  }

  registerWebhook(config: WebhookConfig, source: unknown) {
    return Promise.reject("Not implemented");
  }

  verifyWebhookRequest(options: HandleWebhookOptions) {
    if (!options.request.searchParams.has("hub.verify_token")) {
      return {
        status: "ignored" as const,
        reason: "Missing hub.verify_token",
      };
    }

    if (
      options.secret !== options.request.searchParams.get("hub.verify_token")
    ) {
      return {
        status: "error" as const,
        error: "Invalid secret",
      };
    }

    return {
      status: "ok" as const,
      data: options.request.searchParams.get("hub.challenge"),
    };
  }

  handleWebhookRequest(options: HandleWebhookOptions) {
    console.log(
      "Handling WhatsApp search params",
      options.request.searchParams.toString()
    );
    console.log(
      "Handling WhatsApp headers",
      JSON.stringify(options.request.headers)
    );

    console.log(
      "Handling WhatsApp webhook request",
      JSON.stringify(options.request.body)
    );

    if (!options.secret) {
      return {
        status: "error" as const,
        error: "Missing secret",
      };
    }

    const calculatedChecksum = crypto
      .createHmac("sha256", options.secret)
      .update(options.request.rawBody)
      .digest("hex");

    const expected =
      options.request.headers["x-hub-signature-256"].split("=")[1];
    if (expected !== calculatedChecksum) {
      return {
        status: "error" as const,
        error: "Invalid signature",
      };
    }

    const context = omit(options.request.headers, [
      "x-hub-signature-256",
      "x-hub-signature",
      "content-type",
      "content-length",
      "accept",
      "accept-encoding",
      "x-forwarded-proto",
    ]);

    return {
      status: "ok" as const,
      data: {
        id: ulid(),
        payload: options.request.body,
        event: "messages",
        context,
      },
    };
  }

  displayProperties(source: unknown) {
    return { title: "WhatsApp", properties: [] };
  }
}

export const webhooks = new WhatsAppWebhookIntegration();

function parseWebhookSource(source: unknown) {
  return WebhookSourceSchema.parse(source);
}

function handleMessagesEvent(options: HandleWebhookOptions) {}

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
