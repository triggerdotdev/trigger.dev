import { task, logger } from "@trigger.dev/sdk";
import { orderCreated, orderShipped } from "./events";

// ---- Publish-and-Wait: Fan-out then collect results ----

/**
 * Orchestrator task that publishes an event and waits for all subscribers
 * to finish before proceeding (scatter-gather pattern).
 */
export const processOrder = task({
  id: "process-order",
  run: async (payload: { orderId: string; amount: number; customerId: string }) => {
    logger.info("Starting order processing", { orderId: payload.orderId });

    // Publish and wait for ALL subscribers (sendConfirmationEmail, updateInventory, etc.)
    const result = await orderCreated.publishAndWait({
      orderId: payload.orderId,
      amount: payload.amount,
      customerId: payload.customerId,
      items: [{ sku: "WIDGET-001", qty: 2 }],
    });

    logger.info("All subscribers completed", {
      eventId: result.id,
      subscriberCount: Object.keys(result.results).length,
    });

    // Check results from each subscriber
    for (const [taskSlug, runResult] of Object.entries(result.results)) {
      if (runResult.ok) {
        logger.info(`${taskSlug}: success`, { output: runResult.output });
      } else {
        logger.error(`${taskSlug}: failed`, { error: runResult.error });
      }
    }

    // Continue with next step: publish shipped event
    await orderShipped.publish({
      orderId: payload.orderId,
      trackingNumber: `TRK-${Date.now()}`,
    });

    return { orderId: payload.orderId, status: "completed" };
  },
});
