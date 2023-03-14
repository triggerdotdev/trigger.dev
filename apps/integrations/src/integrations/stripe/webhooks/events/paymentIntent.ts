import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { checkoutCompletedSuccess } from "./checkoutSession.examples";
import { instructions } from "./utilities";

const outputSchemaRef = "#/definitions/payment_intent";

export const paymentIntentSucceeded: WebhookEvent = {
  name: "payment_intent.succeeded",
  metadata: {
    title: "Payment intent succeeded",
    description:
      "Occurs when a PaymentIntent has successfully completed payment.",
    tags: ["payment intent"],
  },
  outputSchemaRef,
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
