import { Stripe } from "@trigger.dev/stripe";
import { client } from "@/trigger";
import { eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

const stripe = new Stripe({
  id: "stripe",
  apiKey: process.env["STRIPE_API_KEY"]!,
});

client.defineJob({
  id: "stripe-example-1",
  name: "Stripe Example 1",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "stripe.example",
    schema: z.object({
      customerId: z.string(),
      source: z.string(),
    }),
  }),
  integrations: {
    stripe,
  },
  run: async (payload, io, ctx) => {
    await io.stripe.createCharge("create-charge", {
      amount: 100,
      currency: "usd",
      source: payload.source,
      customer: payload.customerId,
    });
  },
});

client.defineJob({
  id: "stripe-example-1",
  name: "Stripe Example 1",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "stripe.example",
    schema: z.object({
      customerId: z.string(),
      source: z.string(),
    }),
  }),
  integrations: {
    stripe,
  },
  run: async (payload, io, ctx) => {
    await io.stripe.createCharge("create-charge", {
      amount: 100,
      currency: "usd",
      source: payload.source,
      customer: payload.customerId,
    });
  },
});

client.defineJob({
  id: "stripe-create-customer",
  name: "Stripe Create Customer",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "stripe.new.customer",
    schema: z.object({
      email: z.string(),
      name: z.string(),
    }),
  }),
  integrations: {
    stripe,
  },
  run: async (payload, io, ctx) => {
    await io.stripe.createCustomer("create-customer", {
      email: payload.email,
      name: payload.name,
    });
  },
});

client.defineJob({
  id: "stripe-update-customer",
  name: "Stripe Update Customer",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "stripe.update.customer",
    schema: z.object({
      customerId: z.string(),
      name: z.string(),
    }),
  }),
  integrations: {
    stripe,
  },
  run: async (payload, io, ctx) => {
    await io.stripe.updateCustomer("update-customer", {
      id: payload.customerId,
      name: payload.name,
    });
  },
});

client.defineJob({
  id: "stripe-retrieve-subscription",
  name: "Stripe Retrieve Subscription",
  version: "0.1.0",
  trigger: eventTrigger({
    name: "stripe.retrieve.subscription",
    schema: z.object({
      id: z.string(),
    }),
  }),
  integrations: {
    stripe,
  },
  run: async (payload, io, ctx) => {
    const subscription = await io.stripe.retrieveSubscription("get", {
      id: payload.id,
      expand: ["customer"],
    });
  },
});

client.defineJob({
  id: "stripe-on-price",
  name: "Stripe On Price",
  version: "0.1.0",
  trigger: stripe.onPrice({ events: ["price.created", "price.updated"] }),
  run: async (payload, io, ctx) => {
    if (ctx.event.name === "price.created") {
      await io.logger.info("price created!", { ctx });
    } else {
      await io.logger.info("price updated!", { ctx });
    }
  },
});

client.defineJob({
  id: "stripe-on-price-created",
  name: "Stripe On Price Created",
  version: "0.1.0",
  trigger: stripe.onPriceCreated(),
  run: async (payload, io, ctx) => {
    await io.logger.info("ctx", { ctx });
  },
});

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
    await io.logger.info("ctx", { ctx });
  },
});
