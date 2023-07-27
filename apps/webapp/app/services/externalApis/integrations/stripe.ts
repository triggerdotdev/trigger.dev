import type { Integration } from "../types";

export const stripe: Integration = {
  identifier: "stripe",
  name: "Stripe",
  packageName: "@trigger.dev/stripe",
  authenticationMethods: {
    apikey: {
      type: "apikey",
      help: {
        samples: [
          {
            title: "Creating the integration",
            code: `
import { Stripe } from "@trigger.dev/stripe";

export const stripe = new Stripe({
  id: "__SLUG__",
  apiKey: process.env.PLAIN_API_KEY!,
});
`,
          },
          {
            title: "Using the integration",
            code: `
client.defineJob({
  id: "stripe-playground",
  name: "Stripe Playground",
  version: "0.1.1",
  integrations: {
    stripe,
  },
  trigger: eventTrigger({
    name: "stripe.playground",
  }),
  run: async (payload, io, ctx) => {
    await io.stripe.createCharge("charge-customer", {
      amount: 100,
      currency: "usd",
      source: payload.source,
      customer: payload.customerId,
    });
  },
});
            `,
            highlight: [
              [5, 7],
              [12, 17],
            ],
          },
          {
            title: "Using Stripe triggers",
            code: `
client.defineJob({
  id: "stripe-on-subscription-created",
  name: "Stripe On Subscription Created",
  version: "0.1.0",
  trigger: stripe.onCustomerSubscriptionCreated({
    filter: {
      currency: ["usd"],
    },
  }),
  run: async (payload, io, ctx) => {
    await io.logger.info("Subscription created in USD!");
  },
});
            `,
            highlight: [[5, 9]],
          },
        ],
      },
    },
  },
};
