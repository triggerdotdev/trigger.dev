import { task, type Context } from "@trigger.dev/sdk/v3";

import { Stripe } from "stripe";

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY!, {
  apiVersion: "2022-11-15",
});

export const stripeTask = task({
  id: "stripe-task",
  run: async ({ payload, ctx }: { payload: { prompt: string }; ctx: Context }) => {
    // Do a simple stripe query call
    const response = await stripe.customers.list({
      limit: 3,
    });

    return response;
  },
});
