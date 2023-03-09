import { schemaFromRef } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { spec } from "integrations/stripe/schemas/spec";
import { checkoutCompletedSuccess } from "./checkoutSession.examples";
import { instructions, wrapEventWithWebhookData } from "./utilities";

export const checkoutSessionEventSchema: JSONSchema = wrapEventWithWebhookData(
  "Checkout session",
  schemaFromRef("#/components/schemas/checkout.session", spec)
);

export const checkoutCompleted: WebhookEvent = {
  name: "checkout.session.completed",
  metadata: {
    title: "Checkout session completed",
    description: "A checkout session was completed",
    tags: ["checkout"],
  },
  schema: checkoutSessionEventSchema,
  instructions: (data) => instructions("checkout session complete"),
  examples: [checkoutCompletedSuccess],
  key: "checkout.session.completed",
  displayProperties: (data) => ({
    title: `Stripe checkout completed`,
  }),
  matches: (data) => data.request.body.type === "checkout.session.completed",
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "checkout.session.completed",
      displayProperties: {
        title: `New Stripe checkout`,
        properties: [
          {
            key: "amount",
            value: data.request.body.amount_total,
          },
          {
            key: "currency",
            value: data.request.body.currency,
          },
        ],
      },
      payload: data.request.body,
    },
  ],
};

export const checkoutExpired: WebhookEvent = {
  name: "checkout.session.expired",
  metadata: {
    title: "Checkout session expired",
    description: "A checkout session expired",
    tags: ["checkout"],
  },
  schema: checkoutSessionEventSchema,
  instructions: (data) => instructions("checkout session expired"),
  examples: [checkoutCompletedSuccess],
  key: "checkout.session.expired",
  displayProperties: (data) => ({
    title: `Stripe checkout session expired`,
  }),
  matches: (data) => data.request.body.type === "checkout.session.expired",
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "checkout.session.expired",
      displayProperties: {
        title: `Stripe checkout session expired`,
        properties: [
          {
            key: "amount",
            value: data.request.body.amount_total,
          },
          {
            key: "currency",
            value: data.request.body.currency,
          },
        ],
      },
      payload: data.request.body,
    },
  ],
};

export const checkoutAsyncPaymentFailed: WebhookEvent = {
  name: "checkout.session.async_payment_failed",
  metadata: {
    title: "Checkout session payment failed",
    description:
      "Occurs when a payment intent using a delayed payment method fails.",
    tags: ["checkout"],
  },
  schema: checkoutSessionEventSchema,
  instructions: (data) => instructions("checkout session async payment failed"),
  examples: [checkoutCompletedSuccess],
  key: "checkout.session.async_payment_failed",
  displayProperties: (data) => ({
    title: `Stripe checkout async payment failed`,
  }),
  matches: (data) =>
    data.request.body.type === "checkout.session.async_payment_failed",
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "checkout.session.async_payment_failed",
      displayProperties: {
        title: `Stripe checkout async payment failed`,
        properties: [
          {
            key: "amount",
            value: data.request.body.amount_total,
          },
          {
            key: "currency",
            value: data.request.body.currency,
          },
        ],
      },
      payload: data.request.body,
    },
  ],
};

export const checkoutAsyncPaymentSucceeded: WebhookEvent = {
  name: "checkout.session.async_payment_succeeded",
  metadata: {
    title: "Checkout session async payment succeeded",
    description:
      "Occurs when a payment intent using a delayed payment method finally succeeds.",
    tags: ["checkout"],
  },
  schema: checkoutSessionEventSchema,
  instructions: (data) =>
    instructions("checkout session async payment succeeded"),
  examples: [checkoutCompletedSuccess],
  key: "checkout.session.async_payment_succeeded",
  displayProperties: (data) => ({
    title: `Stripe checkout async payment succeeded`,
  }),
  matches: (data) =>
    data.request.body.type === "checkout.session.async_payment_succeeded",
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "checkout.session.async_payment_succeeded",
      displayProperties: {
        title: `Stripe checkout async payment succeeded`,
        properties: [
          {
            key: "amount",
            value: data.request.body.amount_total,
          },
          {
            key: "currency",
            value: data.request.body.currency,
          },
        ],
      },
      payload: data.request.body,
    },
  ],
};
