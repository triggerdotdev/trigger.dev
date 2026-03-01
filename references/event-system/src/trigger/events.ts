import { event } from "@trigger.dev/sdk";
import { z } from "zod";

// ---- Event Definitions ----

/** Published when an order is placed */
export const orderCreated = event({
  id: "order.created",
  schema: z.object({
    orderId: z.string(),
    amount: z.number(),
    customerId: z.string(),
    items: z.array(z.object({ sku: z.string(), qty: z.number() })),
  }),
});

/** Published when an order is shipped */
export const orderShipped = event({
  id: "order.shipped",
  schema: z.object({
    orderId: z.string(),
    trackingNumber: z.string(),
  }),
});

/** Published for any user action (rate-limited) */
export const userActivity = event({
  id: "user.activity",
  schema: z.object({
    userId: z.string(),
    action: z.string(),
    timestamp: z.string(),
  }),
  rateLimit: {
    limit: 100,
    window: "1m",
  },
});
