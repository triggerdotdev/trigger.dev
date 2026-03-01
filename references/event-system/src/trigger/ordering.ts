import { task, logger } from "@trigger.dev/sdk";
import { orderCreated } from "./events";

// ---- Ordering Keys: Sequential processing per entity ----

/**
 * This publisher uses ordering keys to ensure events for the same customer
 * are processed sequentially (no concurrent runs per customer).
 */
export const placeOrder = task({
  id: "place-order",
  run: async (payload: {
    orderId: string;
    amount: number;
    customerId: string;
  }) => {
    logger.info("Publishing order with ordering key", {
      orderId: payload.orderId,
      customerId: payload.customerId,
    });

    const result = await orderCreated.publish(
      {
        orderId: payload.orderId,
        amount: payload.amount,
        customerId: payload.customerId,
        items: [{ sku: "ITEM-001", qty: 1 }],
      },
      {
        // Events for the same customer are processed one at a time
        orderingKey: payload.customerId,
        // Prevent duplicate publishes
        idempotencyKey: `order-${payload.orderId}`,
      }
    );

    return { eventId: result.id, runs: result.runs.length };
  },
});
