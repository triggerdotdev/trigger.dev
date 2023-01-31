import { z } from "zod";
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
    //todo add some identifier in here for the WhatsApp account/number
    return `messages.${whatsAppSource.events.join(".")}`;
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
    console.log("Handling WhatsApp webhook request", options.request.body);

    return {
      status: "ok" as const,
      data: {
        id: "",
        payload: options.request.body,
        event: "",
        context: {},
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
