import { events, task, logger } from "@trigger.dev/sdk";

// ---- Wildcard Pattern Subscriptions ----

/** Catches all order.* events (order.created, order.shipped, etc.) */
export const orderAuditLog = task({
  id: "order-audit-log",
  on: events.match("order.*"),
  run: async (payload) => {
    // payload is `unknown` for pattern subscriptions
    logger.info("Order event received", { payload });
    return { logged: true };
  },
});

/** Catches all user.# events (user.activity, user.profile.updated, etc.) */
export const userEventTracker = task({
  id: "user-event-tracker",
  on: events.match("user.#"),
  run: async (payload) => {
    logger.info("User event tracked", { payload });
    return { tracked: true };
  },
});
