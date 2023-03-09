import { Trigger } from "@trigger.dev/sdk";
import { events } from "@trigger.dev/stripe";

new Trigger({
  id: "stripe-checkout.session.completed",
  name: "Stripe checkout session completed",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.checkoutSessionCompletedEvent(),
  run: async (event, ctx) => {
    return {};
  },
}).listen();

new Trigger({
  id: "stripe-checkout.session.expired",
  name: "Stripe checkout session expired",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.checkoutSessionExpiredEvent(),
  run: async (event, ctx) => {
    return {};
  },
}).listen();

new Trigger({
  id: "stripe-checkout.session.asyncpaymentfailed",
  name: "Stripe checkout session async payment failed",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.checkoutSessionAsyncPaymentFailedEvent(),
  run: async (event, ctx) => {
    return {};
  },
}).listen();

new Trigger({
  id: "stripe-checkout.session.asyncpaymentsucceeded",
  name: "Stripe checkout session async payment succeeded",
  apiKey: "trigger_dev_zC25mKNn6c0q",
  endpoint: "ws://localhost:8889/ws",
  logLevel: "debug",
  on: events.checkoutSessionAsyncPaymentSucceededEvent(),
  run: async (event, ctx) => {
    return {};
  },
}).listen();
