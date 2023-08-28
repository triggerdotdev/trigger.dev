import {
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  type HandlerEvent,
  type IntegrationClient,
  type Logger,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import { Stripe as StripeClient } from "stripe";
import type { StripeIntegrationOptions, StripeSDK, WebhookEvents } from "./types";

import z from "zod";
import * as events from "./events";
import * as tasks from "./tasks";

export * from "./types";

type StripeIntegrationClient = IntegrationClient<StripeSDK, typeof tasks>;
type StripeIntegration = TriggerIntegration<StripeIntegrationClient>;

export class Stripe implements StripeIntegration {
  client: StripeIntegrationClient;

  /**
   * The native Stripe client. This is exposed for use outside of Trigger.dev jobs
   *
   * @example
   * ```ts
   * import { Stripe } from "@trigger.dev/stripe";
   *
   * const stripe = new Stripe({
   *  id: "stripe",
   *  apiKey: process.env.STRIPE_API_KEY!,
   * });
   *
   * const customer = await stripe.native.customers.create({}); // etc.
   * ```
   */
  public readonly native: StripeClient;

  constructor(private options: StripeIntegrationOptions) {
    this.native = new StripeClient(options.apiKey, {
      apiVersion: "2022-11-15",
      typescript: true,
      timeout: 10000,
      maxNetworkRetries: 0,
      stripeAccount: options.stripeAccount,
      appInfo: {
        name: "Trigger.dev Stripe Integration",
        version: "0.1.0",
        url: "https://trigger.dev",
      },
    });

    this.client = {
      tasks,
      usesLocalAuth: true,
      client: this.native,
      auth: {
        apiKey: options.apiKey,
      },
    };
  }

  get id() {
    return this.options.id;
  }

  get metadata() {
    return { id: "stripe", name: "Stripe" };
  }

  get source() {
    return createWebhookEventSource(this);
  }

  /**
   * Occurs whenever a price is created, updated, or deleted. Accepts an optional array of events to filter on. By default it will listen to all price events.
   *
   * @example
   * ```ts
   * stripe.onPrice({ events: ["price.created", "price.updated"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-price",
   *   name: "Stripe Price",
   *   version: "0.1.0",
   *   trigger: stripe.onPrice({ events: ["price.created", "price.updated"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "price.created" or "price.updated"
   *   },
   * });
   * ```
   */
  onPrice(
    params?: TriggerParams & { events?: Array<"price.created" | "price.updated" | "price.deleted"> }
  ) {
    const event = { ...events.onPrice, name: params?.events ?? events.onPrice.name };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a price is created.
   */
  onPriceCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPriceCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a price is updated.
   */
  onPriceUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPriceUpdated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a price is deleted.
   */
  onPriceDeleted(params?: TriggerParams) {
    return createTrigger(this.source, events.onPriceDeleted, params ?? { connect: false });
  }

  /**
   * Occurs whenever a product is created, updated, or deleted. Accepts an optional array of events to filter on. By default it will listen to all product events.
   *
   * @example
   * ```ts
   * stripe.onProduct({ events: ["product.created", "product.updated"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onProduct({ events: ["product.created", "product.updated"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "product.created" or "product.updated"
   *   },
   * });
   * ```
   */
  onProduct(
    params?: TriggerParams & {
      events?: Array<"product.created" | "product.updated" | "product.deleted">;
    }
  ) {
    const event = { ...events.onProduct, name: params?.events ?? events.onProduct.name };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a product is created.
   */
  onProductCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onProductCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a product is updated.
   */
  onProductUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onProductUpdated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a product is deleted.
   */
  onProductDeleted(params?: TriggerParams) {
    return createTrigger(this.source, events.onProductDeleted, params ?? { connect: false });
  }

  /**
   * Occurs whenever a checkout.session is completed, expired, async_payment_succeeded, or async_payment_failed. Accepts an optional array of events to filter on. By default it will listen to all checkout.session events.
   *
   * @example
   * ```ts
   * stripe.onCheckoutSession({ events: ["session.checkout.completed", "session.checkout.expired"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onCheckoutSession({ events: ["checkout.session.completed", "checkout.session.expired"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "checkout.session.completed" or "checkout.session.expired"
   *   },
   * });
   * ```
   */
  onCheckoutSession(
    params?: TriggerParams & {
      events?: Array<
        | "checkout.session.completed"
        | "checkout.session.async_payment_succeeded"
        | "checkout.session.async_payment_failed"
        | "checkout.session.expired"
      >;
    }
  ) {
    const event = {
      ...events.onCheckoutSession,
      name: params?.events ?? events.onCheckoutSession.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs when a Checkout Session has been successfully completed.
   */
  onCheckoutSessionCompleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCheckoutSessionCompleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a Checkout Session is expired.
   */
  onCheckoutSessionExpired(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCheckoutSessionExpired,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs on any customer.subscription.* event. Accepts an optional array of events to filter on. By default it will listen to all customer.subscription.* events.
   *
   * @example
   * ```ts
   * stripe.onCustomerSubscription({ events: ["customer.subscription.created", "customer.subscription.resumed"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onCustomerSubscription({ events: ["customer.subscription.created", "customer.subscription.resumed"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "customer.subscription.created" or "customer.subscription.resumed"
   *   },
   * });
   * ```
   */
  onCustomerSubscription(
    params?: TriggerParams & {
      events?: Array<
        | "customer.subscription.created"
        | "customer.subscription.deleted"
        | "customer.subscription.updated"
        | "customer.subscription.paused"
        | "customer.subscription.pending_update_applied"
        | "customer.subscription.pending_update_expired"
        | "customer.subscription.resumed"
      >;
    }
  ) {
    const event = {
      ...events.onCustomerSubscription,
      name: params?.events ?? events.onCustomerSubscription.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a customer is signed up for a new plan.
   */
  onCustomerSubscriptionCreated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionCreated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription is paused. Only applies when subscriptions enter `status=paused`, not when [payment collection](https://stripe.com/docs/billing/subscriptions/pause) is paused.
   */
  onCustomerSubscriptionPaused(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionPaused,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription is no longer paused. Only applies when a `status=paused` subscription is [resumed](https://stripe.com/docs/api/subscriptions/resume), not when [payment collection](https://stripe.com/docs/billing/subscriptions/pause) is resumed.
   */
  onCustomerSubscriptionResumed(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionResumed,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a subscription changes (e.g., switching from one plan to another, or changing the status from trial to active).
   */
  onCustomerSubscriptionUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever a customer's subscription ends.
   */
  onCustomerSubscriptionDeleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onCustomerSubscriptionDeleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever an account status or property has changed.
   */
  onAccountUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onAccountUpdated, params ?? { connect: false });
  }

  /**
   * Occurs on customer.created, customer.deleted, and customer.updated
   *
   * @example
   * ```ts
   * stripe.onCustomer()
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onCustomer(),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "customer.created" or "customer.deleted"
   *   },
   * });
   * ```
   */
  onCustomer(
    params?: TriggerParams & {
      events?: Array<"customer.created" | "customer.deleted">;
    }
  ) {
    const event = {
      ...events.onCustomer,
      name: params?.events ?? events.onCustomer.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a new customer is created.
   */
  onCustomerCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onCustomerCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a new customer is deleted.
   */
  onCustomerDeleted(params?: TriggerParams) {
    return createTrigger(this.source, events.onCustomerDeleted, params ?? { connect: false });
  }

  /**
   * Occurs whenever a new customer is updated.
   */
  onCustomerUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onCustomerUpdated, params ?? { connect: false });
  }

  /**
   * Occurs on any charge.* event. Accepts an optional array of events to filter on. By default it will listen to all charge.* events.
   *
   * @example
   * ```ts
   * stripe.onCharge({ events: ["charge.refunded", "charge.succeeded"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onCharge({ events: ["charge.refunded", "charge.succeeded"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "charge.refunded" or "charge.succeeded"
   *   },
   * });
   * ```
   */
  onCharge(
    params?: TriggerParams & {
      events?: Array<
        | "charge.captured"
        | "charge.expired"
        | "charge.failed"
        | "charge.pending"
        | "charge.refunded"
        | "charge.succeeded"
        | "charge.updated"
      >;
    }
  ) {
    const event = {
      ...events.onCharge,
      name: params?.events ?? events.onCharge.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a previously uncaptured charge is captured
   */
  onChargeCaptured(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeCaptured, params ?? { connect: false });
  }

  /**
   * Occurs whenever an uncaptured charge expires.
   */
  onChargeExpired(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeExpired, params ?? { connect: false });
  }

  /**
   * Occurs whenever a failed charge attempt occurs
   */
  onChargeFailed(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeFailed, params ?? { connect: false });
  }

  /**
   * Occurs whenever a pending charge is created
   */
  onChargePending(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargePending, params ?? { connect: false });
  }

  /**
   * Occurs whenever a charge is refunded, including partial refunds
   */
  onChargeRefunded(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeRefunded, params ?? { connect: false });
  }

  /**
   * Occurs whenever a charge is successful
   */
  onChargeSucceeded(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeSucceeded, params ?? { connect: false });
  }

  /**
   * Occurs whenever a charge description or metadata is updated, or upon an asynchronous capture
   */
  onChargeUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onChargeUpdated, params ?? { connect: false });
  }

  /**
   * Occurs on any account.external_account.* event. Accepts an optional array of events to filter on. By default it will listen to all charge.* events.
   *
   * @example
   * ```ts
   * stripe.onExternalAccount({ events: ["account.external_account.created", "account.external_account.deleted"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onExternalAccount({ events: ["account.external_account.created", "account.external_account.deleted"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "account.external_account.created" or "account.external_account.deleted"
   *   },
   * });
   * ```
   */
  onExternalAccount(
    params?: TriggerParams & {
      events?: Array<
        | "account.external_account.created"
        | "account.external_account.deleted"
        | "account.external_account.updated"
      >;
    }
  ) {
    const event = {
      ...events.onExternalAccount,
      name: params?.events ?? events.onExternalAccount.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever an external account is created.
   * */
  onExternalAccountCreated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onExternalAccountCreated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever an external account is deleted.
   * */
  onExternalAccountDeleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onExternalAccountDeleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever an external account is updated.
   * */
  onExternalAccountUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onExternalAccountUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs on any person.* event. Accepts an optional array of events to filter on. By default it will listen to all person.* events.
   *
   * @example
   * ```ts
   * stripe.onPerson({ events: ["person.created", "person.deleted"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onPerson({ events: ["person.created", "person.deleted"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "person.created" or "person.deleted"
   *   },
   * });
   * ```
   */
  onPerson(
    params?: TriggerParams & {
      events?: Array<"person.created" | "person.deleted" | "person.updated">;
    }
  ) {
    const event = {
      ...events.onPerson,
      name: params?.events ?? events.onPerson.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a person associated with an account is created.
   * */
  onPersonCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPersonCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a person associated with an account is deleted.
   * */
  onPersonDeleted(params?: TriggerParams) {
    return createTrigger(this.source, events.onPersonDeleted, params ?? { connect: false });
  }

  /**
   * Occurs whenever a person associated with an account is updated.
   * */
  onPersonUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPersonUpdated, params ?? { connect: false });
  }
}

export type TriggerParams = {
  connect?: boolean;
  filter?: EventFilter;
};

type StripeEvents = (typeof events)[keyof typeof events];

type CreateTriggersResult<TEventSpecification extends StripeEvents> = ExternalSourceTrigger<
  TEventSpecification,
  ReturnType<typeof createWebhookEventSource>
>;

function createTrigger<TEventSpecification extends StripeEvents>(
  source: ReturnType<typeof createWebhookEventSource>,
  event: TEventSpecification,
  params: TriggerParams
): CreateTriggersResult<TEventSpecification> {
  return new ExternalSourceTrigger({
    event,
    params,
    source,
  });
}

const WebhookDataSchema = z.object({
  id: z.string(),
  object: z.literal("webhook_endpoint"),
  api_version: z.string().nullable(),
  application: z.string().nullable(),
  created: z.number(),
  description: z.string().nullable(),
  enabled_events: z.array(z.string()),
  livemode: z.boolean(),
  metadata: z.record(z.string()),
  status: z.enum(["enabled", "disabled"]),
  url: z.string(),
});

function createWebhookEventSource(
  integration: StripeIntegration
): ExternalSource<StripeIntegration, { connect?: boolean }, "HTTP"> {
  return new ExternalSource("HTTP", {
    id: "stripe.webhook",
    schema: z.object({ connect: z.boolean().optional() }),
    version: "0.1.0",
    integration,
    key: (params) => `stripe.webhook${params.connect ? ".connect" : ""}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, events, missingEvents } = event;

      const webhookData = WebhookDataSchema.safeParse(httpSource.data);

      const allEvents = Array.from(new Set([...events, ...missingEvents]));

      if (httpSource.active && webhookData.success) {
        if (missingEvents.length === 0) return;

        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: webhookData.data.id,
          url: httpSource.url,
          enabled_events: allEvents as unknown as WebhookEvents[],
        });

        return {
          data: WebhookDataSchema.parse(updatedWebhook),
          registeredEvents: allEvents,
        };
      }

      const listResponse = await io.integration.listWebhooks("list-webhooks", {
        limit: 100,
      });

      const existingWebhook = listResponse.data.find((w) => w.url === httpSource.url);

      if (existingWebhook) {
        const updatedWebhook = await io.integration.updateWebhook("update-found-webhook", {
          id: existingWebhook.id,
          url: httpSource.url,
          enabled_events: allEvents as unknown as WebhookEvents[],
          disabled: false,
        });

        return {
          data: WebhookDataSchema.parse(updatedWebhook),
          registeredEvents: allEvents,
        };
      }

      const webhook = await io.integration.createWebhook("create-webhook", {
        url: httpSource.url,
        enabled_events: allEvents as unknown as WebhookEvents[],
        connect: params.connect,
      });

      return {
        data: WebhookDataSchema.parse(webhook),
        secret: webhook.secret,
        registeredEvents: allEvents,
      };
    },
  });
}

async function webhookHandler(event: HandlerEvent<"HTTP">, logger: Logger) {
  logger.debug("[@trigger.dev/stripe] Handling webhook payload");

  const { rawEvent: request, source } = event;

  if (!request.body) {
    logger.debug("[@trigger.dev/stripe] No body found");

    return { events: [] };
  }

  const rawBody = await request.text();

  const signature = request.headers.get("stripe-signature");

  if (signature) {
    const stripeClient = new StripeClient("", { apiVersion: "2022-11-15" });

    try {
      const event = stripeClient.webhooks.constructEvent(rawBody, signature, source.secret);

      return {
        events: [
          {
            id: event.id,
            payload: event.data.object,
            source: "stripe.com",
            name: event.type,
            timestamp: new Date(event.created * 1000),
            context: {
              apiVersion: event.api_version,
              livemode: event.livemode,
              request: event.request,
              previousAttributes: event.data.previous_attributes,
            },
          },
        ],
      };
    } catch (error) {
      if (error instanceof Error) {
        logger.error("[@trigger.dev/stripe] Error while validating webhook signature", {
          error: { name: error.name, message: error.message },
        });
      } else {
        logger.error("[@trigger.dev/stripe] Unknown Error while validating webhook signature");
      }

      return { events: [] };
    }
  }

  return {
    events: [],
  };
}
