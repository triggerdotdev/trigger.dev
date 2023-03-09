import { makeWebhook } from "core/webhook";
import Stripe from "stripe";
import { authentication } from "../authentication";
import {
  checkoutAsyncPaymentFailed,
  checkoutAsyncPaymentSucceeded,
  checkoutCompleted,
  checkoutExpired,
} from "./events/checkoutSession";
import { paymentIntentSucceeded } from "./events/paymentIntent";
import { webhookSpec } from "./specs";

const baseUrl = "https://api.stripe.com/v1";

const webhook = makeWebhook({
  data: {
    baseUrl,
    spec: webhookSpec,
    authentication,
  },
  events: [
    checkoutCompleted,
    checkoutExpired,
    checkoutAsyncPaymentSucceeded,
    checkoutAsyncPaymentFailed,
    paymentIntentSucceeded,
  ],
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
