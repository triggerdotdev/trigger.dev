import { Trigger } from "@trigger.dev/sdk";
import { events } from "@trigger.dev/stripe";

new Trigger({
  id: "stripe-checout.session.completed",
  name: "Stripe checkout session completed",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.checkoutSessionCompletedEvent(),
  run: async (event, ctx) => {
    return {};
  },
}).listen();
