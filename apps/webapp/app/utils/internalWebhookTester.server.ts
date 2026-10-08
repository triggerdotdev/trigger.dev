import { json } from "@remix-run/server-runtime";
import type { Logger } from "@trigger.dev/core/logger";
import { WebhookError, webhooks } from "@trigger.dev/sdk/v3";

/*
  This route is for testing our webhooks
*/
export async function handleInternalWebhookTest(
  request: Request,
  { nodeEnv, webhookSecret, logger }: { nodeEnv: string; webhookSecret?: string; logger: Logger }
) {
  if (nodeEnv === "production") {
    return new Response("Not found", { status: 404 });
  }

  // Make sure this is a POST request
  if (request.method !== "POST") {
    return json({ error: "[Webhook Internal Test] Method not allowed" }, { status: 405 });
  }

  try {
    // Construct and verify the webhook event
    const event = await webhooks.constructEvent(request, webhookSecret!);

    // Handle the webhook event
    logger.log("[Webhook Internal Test] Received verified webhook:", { type: event.type });

    // Process the event based on its type
    switch (event.type) {
      default:
        logger.log(`[Webhook Internal Test] Unhandled event type: ${event.type}`);
    }

    // Return a success response
    return json({ received: true }, { status: 200 });
  } catch (err) {
    // Handle webhook errors
    if (err instanceof WebhookError) {
      logger.error("[Webhook Internal Test] Webhook error:", { message: err.message });
      return json({ error: err.message }, { status: 400 });
    }

    if (err instanceof Error) {
      logger.error("[Webhook Internal Test] Error processing webhook:", { message: err.message });
      return json({ error: err.message }, { status: 400 });
    }

    // Handle other errors
    logger.error("[Webhook Internal Test] Error processing webhook:", { err });
    return json({ error: "Internal server error" }, { status: 500 });
  }
}
