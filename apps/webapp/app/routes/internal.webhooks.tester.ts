import { ActionFunctionArgs, json } from "@remix-run/server-runtime";
import { webhooks } from "@trigger.dev/sdk/v3";
import { WebhookError } from "@trigger.dev/sdk/v3";
import { logger } from "~/services/logger.server";

/*
  This route is for testing our webhooks
*/
export async function action({ request }: ActionFunctionArgs) {
  // Make sure this is a POST request
  if (request.method !== "POST") {
    return json({ error: "[Webhook Internal Test] Method not allowed" }, { status: 405 });
  }

  const clonedRequest = request.clone();
  const rawBody = await clonedRequest.text();
  logger.log("[Webhook Internal Test] Raw body:", { rawBody });

  try {
    // Construct and verify the webhook event
    const event = await webhooks.constructEvent(request, process.env.INTERNAL_TEST_WEBHOOK_SECRET!);

    // Handle the webhook event
    logger.log("[Webhook Internal Test] Received verified webhook:", event);

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
