import { schemaFromRef } from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { spec } from "integrations/stripe/schemas/spec";
import { checkoutCompletedSuccess } from "./checkoutSession.examples";
import { wrapEventWithWebhookData } from "./utilities";

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
  instructions: (data) =>
    `Perform a Stripe checkout session or use the [Stripe CLI](https://stripe.com/docs/stripe-cli) to test this webhook.`,
  examples: [checkoutCompletedSuccess],
  key: "checkout.session.completed",
  displayProperties: (data) => ({
    title: `New Stripe checkout`,
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
