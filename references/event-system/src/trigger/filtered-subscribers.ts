import { task, logger } from "@trigger.dev/sdk";
import { orderCreated } from "./events";

// ---- Content-based Filtering: Only receive events that match ----

/** Only handles high-value orders (amount >= 1000) */
export const highValueOrderHandler = task({
  id: "high-value-order",
  on: orderCreated,
  filter: {
    amount: [{ $gte: 1000 }],
  },
  run: async (payload) => {
    logger.info("High-value order detected!", {
      orderId: payload.orderId,
      amount: payload.amount,
    });

    // Alert VIP team, apply special handling, etc.
    return { flagged: true, amount: payload.amount };
  },
});

/** Only handles orders from a specific customer */
export const vipCustomerHandler = task({
  id: "vip-customer-handler",
  on: orderCreated,
  filter: {
    customerId: ["customer-vip-001", "customer-vip-002"],
  },
  run: async (payload) => {
    logger.info("VIP customer order", { customerId: payload.customerId });
    return { vip: true };
  },
});
