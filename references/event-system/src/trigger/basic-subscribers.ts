import { task, logger } from "@trigger.dev/sdk";
import { orderCreated, orderShipped } from "./events";

// ---- Basic Fan-out: Multiple tasks subscribe to the same event ----

/** Send a confirmation email when an order is created */
export const sendConfirmationEmail = task({
  id: "send-confirmation-email",
  on: orderCreated,
  run: async (payload) => {
    logger.info("Sending confirmation email", {
      orderId: payload.orderId,
      customerId: payload.customerId,
    });

    // Simulate email sending
    return { sent: true, to: payload.customerId };
  },
});

/** Update inventory when an order is created */
export const updateInventory = task({
  id: "update-inventory",
  on: orderCreated,
  run: async (payload) => {
    logger.info("Updating inventory", {
      orderId: payload.orderId,
      itemCount: payload.items.length,
    });

    for (const item of payload.items) {
      logger.info(`Adjusting stock: ${item.sku} -${item.qty}`);
    }

    return { adjusted: payload.items.length };
  },
});

/** Notify customer when order is shipped */
export const notifyShipped = task({
  id: "notify-shipped",
  on: orderShipped,
  run: async (payload) => {
    logger.info("Order shipped notification", {
      orderId: payload.orderId,
      tracking: payload.trackingNumber,
    });

    return { notified: true };
  },
});
