import { makeWebhook } from "core/webhook";
import { WebhookEvent, WebhookReceiveRequest } from "core/webhook/types";
import crypto from "node:crypto";
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
    title: `New response for form ${data.form_id}`,
    properties: [
      {
        key: "Form ID",
        value: data.form_id,
      },
    ],
  }),
  matches: () => true,
  process: async (data: WebhookReceiveRequest) => [
    {
      event: "checkout.session.completed",
      displayProperties: {
        title: "New response",
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
      //https://stripe.com/docs/webhooks/signatures#verify-manually
      const signatureHeader = data.request.headers["stripe-signature"];
      const elements = signatureHeader.split(",");
      const timestamp = elements[0].split("=")[1];
      const signature = elements[1].split("=")[1];
      const contentToEncode = `${timestamp}.${data.request.rawBody}`;
      const hash = crypto
        .createHmac("sha256", data.secret)
        .update(contentToEncode)
        .digest("base64");

      if (signature !== `sha256=${hash}`) {
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
