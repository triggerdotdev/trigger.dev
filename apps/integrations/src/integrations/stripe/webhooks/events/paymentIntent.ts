import { schemaFromRef } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { spec } from "integrations/stripe/schemas/spec";
import { checkoutCompletedSuccess } from "./checkoutSession.examples";
import { instructions, wrapEventWithWebhookData } from "./utilities";

export const paymentIntentEventSchema: JSONSchema = wrapEventWithWebhookData(
  "Payment intent",
  schemaFromRef("#/components/schemas/payment_intent", spec)
);

export const paymentIntentSucceeded: WebhookEvent = {
  name: "payment_intent.succeeded",
  metadata: {
    title: "Payment intent succeeded",
    description:
      "Occurs when a PaymentIntent has successfully completed payment.",
    tags: ["payment intent"],
  },
  schema: paymentIntentEventSchema,
  instructions: (data) => instructions("payment intent succeeded"),
  examples: [checkoutCompletedSuccess],
  key: "payment_intent.succeeded",
  displayProperties: (data) => ({
    title: `Stripe payment intent succeeded`,
  }),
  matches: (data) => data.request.body.type === "payment_intent.succeeded",
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "payment_intent.succeeded",
      displayProperties: {
        title: `Payment intent succeeded`,
        properties: [
          {
            key: "amount",
            value: data.request.body.amount,
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
