import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import { JSONSchema } from "json-schema-to-typescript";
import Stripe from "stripe";
import { authentication } from "../authentication";
import { checkoutCompletedSuccess } from "./examples";
import { checkoutSessionCompletedSchema } from "./schemas";
import { webhookSpec } from "./specs";

const baseUrl = "https://api.stripe.com/v1";

export const checkoutCompleted: WebhookEvent = {
  name: "checkout.session.completed",
  metadata: {
    title: "Checkout session completed",
    description: "A form response was submitted",
    tags: ["checkout"],
  },
  schema: checkoutSessionCompletedSchema,
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

const webhook = makeWebhook({
  data: {
    baseUrl,
    spec: webhookSpec,
    authentication,
  },
  events: [checkoutCompleted],
  subscription: {
    type: "automatic",
    requiresSecret: true,
    inputSchema: null,
    preSubscribe: (input) => {
      return {
        body: {
          description: `Trigger.dev webhook for events ${input.events.join(
            ", "
          )}`,
          enabled_events: input.events,
          url: input.callbackUrl,
        },
      };
    },
    postSubscribe: (result) => {
      //get the secret from the response and add it to the result
      if (result.success) {
        result.secret = result.data.secret;
      }
      return result;
    },
  },
  preProcess: async (data) => {
    if (data.secret) {
      const signatureHeader = data.request.headers["stripe-signature"];
      try {
        const client = new Stripe(data.secret, {
          apiVersion: "2022-11-15",
        });
        const event = client.webhooks.constructEvent(
          data.request.rawBody,
          signatureHeader,
          data.secret
        );
      } catch (e) {
        return {
          success: false,
          processEvents: false,
          error: "Invalid signature",
          response: {
            status: 401,
            headers: {},
          },
        };
      }
    }

    return {
      success: true,
      processEvents: true,
      response: {
        status: 200,
        headers: {},
      },
    };
  },
});

export const webhooks = { webhook };
export const events = { checkoutCompleted };
