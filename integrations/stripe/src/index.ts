import {
  ConnectionAuth,
  EventFilter,
  ExternalSource,
  ExternalSourceTrigger,
  IO,
  IOTask,
  IntegrationTaskKey,
  Json,
  RunTaskErrorCallback,
  RunTaskOptions,
  retry,
  type HandlerEvent,
  type Logger,
  type TriggerIntegration,
} from "@trigger.dev/sdk";
import { Stripe as StripeClient } from "stripe";
import type { StripeIntegrationOptions, WebhookEvents } from "./types";

import z from "zod";
import { Charges } from "./charges";
import { Checkout } from "./checkout";
import { Customers } from "./customers";
import * as events from "./events";
import {
  ChargeEventNames,
  ChargeEventNamesSchema,
  CheckoutSessionEventNames,
  CheckoutSessionEventNamesSchema,
  CustomerEventNames,
  CustomerSubscriptionEventNames,
  CustomerSubscriptionEventNamesSchema,
  ExternalAccountEventNames,
  ExternalAccountEventNamesSchema,
  InvoiceEventNames,
  InvoiceEventNamesSchema,
  PaymentIntentEventNames,
  PaymentIntentEventNamesSchema,
  PayoutEventNames,
  PayoutEventNamesSchema,
  PersonEventNames,
  PersonEventNamesSchema,
  PriceEventNames,
  PriceEventNamesSchema,
  ProductEventNames,
  ProductEventNamesSchema,
} from "./schemas";
import { Subscriptions } from "./subscriptions";
import { WebhookEndpoints } from "./webhookEndpoints";

export * from "./types";

export type StripeRunTask = InstanceType<typeof Stripe>["runTask"];

export class Stripe implements TriggerIntegration {
  // @internal
  private _options: StripeIntegrationOptions;
  // @internal
  private _client?: StripeClient;
  // @internal
  private _io?: IO;
  // @internal
  private _connectionKey?: string;

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
  public readonly native?: StripeClient;

  constructor(private options: StripeIntegrationOptions) {
    this._options = options;

    this.native = options.apiKey
      ? new StripeClient(options.apiKey, {
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
        })
      : undefined;
  }

  get authSource() {
    return "LOCAL" as const;
  }

  cloneForRun(io: IO, connectionKey: string, auth?: ConnectionAuth) {
    const apiKey = this._options.apiKey ?? auth?.accessToken;

    if (!apiKey) {
      throw new Error(
        `Can't initialize Stripe integration (${this._options.id}) as apiKey was undefined`
      );
    }

    const stripe = new Stripe(this._options);
    stripe._io = io;
    stripe._connectionKey = connectionKey;
    stripe._client = new StripeClient(apiKey, {
      apiVersion: "2022-11-15",
      typescript: true,
      timeout: 10000,
      maxNetworkRetries: 0,
      stripeAccount: this._options.stripeAccount,
      appInfo: {
        name: "Trigger.dev Stripe Integration",
        version: "0.1.0",
        url: "https://trigger.dev",
      },
    });
    return stripe;
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

  runTask<T, TResult extends Json<T> | void>(
    key: IntegrationTaskKey,
    callback: (client: StripeClient, task: IOTask, io: IO) => Promise<TResult>,
    options?: RunTaskOptions,
    errorCallback?: RunTaskErrorCallback
  ): Promise<TResult> {
    if (!this._io) throw new Error("No IO");
    if (!this._connectionKey) throw new Error("No connection key");
    return this._io.runTask(
      key,
      (task, io) => {
        if (!this._client) throw new Error("No client");
        return callback(this._client, task, io);
      },
      {
        icon: "stripe",
        retry: retry.standardBackoff,
        ...(options ?? {}),
        connectionKey: this._connectionKey,
      },
      errorCallback
    );
  }

  get charges() {
    return new Charges(this.runTask.bind(this));
  }

  createCharge = this.charges.create;

  get customers() {
    return new Customers(this.runTask.bind(this));
  }

  createCustomer = this.customers.create;
  updateCustomer = this.customers.update;

  get subscriptions() {
    return new Subscriptions(this.runTask.bind(this));
  }

  retrieveSubscription = this.subscriptions.retrieve;

  get checkout() {
    return new Checkout(this.runTask.bind(this));
  }

  createCheckoutSession = this.checkout.sessions.create;

  get webhookEndpoints() {
    return new WebhookEndpoints(this.runTask.bind(this));
  }

  createWebhook = this.webhookEndpoints.create;
  updateWebhook = this.webhookEndpoints.update;
  listWebhooks = this.webhookEndpoints.list;

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
  onPrice(params?: TriggerParams & { events?: PriceEventNames }) {
    const parsedEvents = PriceEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onPrice,
      name: parsedEvents ?? events.onPrice.name,
    };

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
  onProduct(params?: TriggerParams & { events?: ProductEventNames }) {
    const parsedEvents = ProductEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onProduct,
      name: parsedEvents ?? events.onProduct.name,
    };

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
  onCheckoutSession(params?: TriggerParams & { events?: CheckoutSessionEventNames }) {
    const parsedEvents = CheckoutSessionEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onCheckoutSession,
      name: parsedEvents ?? events.onCheckoutSession.name,
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
  onCustomerSubscription(params?: TriggerParams & { events?: CustomerSubscriptionEventNames }) {
    const parsedEvents = CustomerSubscriptionEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onCustomerSubscription,
      name: parsedEvents ?? events.onCustomerSubscription.name,
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
    return createTrigger(this.source, events.onAccountUpdated, params ?? { connect: true });
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
  onCustomer(params?: TriggerParams & { events?: CustomerEventNames }) {
    const parsedEvents = CustomerSubscriptionEventNamesSchema.optional().parse(params?.events);

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
  onCharge(params?: TriggerParams & { events?: ChargeEventNames }) {
    const parsedEvents = ChargeEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onCharge,
      name: parsedEvents ?? events.onCharge.name,
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
  onExternalAccount(params?: TriggerParams & { events?: ExternalAccountEventNames }) {
    const parsedEvents = ExternalAccountEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onExternalAccount,
      name: parsedEvents ?? events.onExternalAccount.name,
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
  onPerson(params?: TriggerParams & { events?: PersonEventNames }) {
    const parsedEvents = PersonEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onPerson,
      name: parsedEvents ?? events.onPerson.name,
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

  /**
   * Occurs on any payment_intent.* event. Accepts an optional array of events to filter on. By default it will listen to all payment_intent.* events.
   *
   * @example
   * ```ts
   * stripe.onPaymentIntent({ events: ["payment_intent.created", "payment_intent.succeeded"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onPaymentIntent({ events: ["payment_intent.created", "payment_intent.succeeded"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "payment_intent.created" or "payment_intent.succeeded"
   *   },
   * });
   * ```
   */
  onPaymentIntent(params?: TriggerParams & { events?: PaymentIntentEventNames }) {
    const parsedEvents = PaymentIntentEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onPaymentIntent,
      name: parsedEvents ?? events.onPaymentIntent.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs when a new PaymentIntent is created..
   * */
  onPaymentIntentCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPaymentIntentCreated, params ?? { connect: false });
  }

  /**
   * Occurs when a PaymentIntent has successfully completed payment.
   * */
  onPaymentIntentSucceeded(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentSucceeded,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a PaymentIntent is canceled.
   * */
  onPaymentIntentCancelled(params?: TriggerParams) {
    return createTrigger(this.source, events.onPaymentIntentCanceled, params ?? { connect: false });
  }

  /**
   * Occurs when a PaymentIntent has started processing.
   * */
  onPaymentIntentProcessing(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentProcessing,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a PaymentIntent transitions to requires_action state
   * */
  onPaymentIntentRequiresAction(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentRequiresAction,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a PaymentIntent has funds to be captured. Check the amount_capturable property on the PaymentIntent to determine the amount that can be captured. You may capture the PaymentIntent with an amount_to_capture value up to the specified amount. [Learn more about capturing PaymentIntents](https://stripe.com/docs/api/payment_intents/capture)
   * */
  onPaymentIntentAmountCapturableUpdated(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentAmountCapturableUpdated,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when a PaymentIntent has failed the attempt to create a payment method or a payment.
   * */
  onPaymentIntentPaymentFailed(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentPaymentFailed,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs when funds are applied to a customer_balance PaymentIntent and the ‘amount_remaining’ changes.
   * */
  onPaymentIntentPartiallyFunded(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPaymentIntentPartiallyFunded,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs on any payout.* event. Accepts an optional array of events to filter on. By default it will listen to all payout.* events.
   *
   * @example
   * ```ts
   * stripe.onPayout({ events: ["payout.created", "payout.paid"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onPayout({ events: ["payout.created", "payout.paid"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "payout.created" or "payout.paid"
   *   },
   * });
   * ```
   */
  onPayout(params?: TriggerParams & { events?: PayoutEventNames }) {
    const parsedEvents = PayoutEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onPayout,
      name: parsedEvents ?? events.onPayout.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever a payout is created.
   * */
  onPayoutCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPayoutCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a payout is updated.
   * */
  onPayoutUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onPayoutUpdated, params ?? { connect: false });
  }

  /**
   * Occurs whenever a payout is canceled.
   * */
  onPayoutCanceled(params?: TriggerParams) {
    return createTrigger(this.source, events.onPayoutCancelled, params ?? { connect: false });
  }

  /**
   * Occurs whenever a payout attempt fails.
   * */
  onPayoutFailed(params?: TriggerParams) {
    return createTrigger(this.source, events.onPayoutFailed, params ?? { connect: false });
  }

  /**
   * Occurs whenever a payout is expected to be available in the destination account. If the payout fails, a `payout.failed` notification is also sent, at a later time.
   * */
  onPayoutPaid(params?: TriggerParams) {
    return createTrigger(this.source, events.onPayoutPaid, params ?? { connect: false });
  }

  /**
   * Occurs whenever balance transactions paid out in an automatic payout can be queried.
   * */
  onPayoutReconciliationCompleted(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onPayoutReconciliationCompleted,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs on any invoice.* event. Accepts an optional array of events to filter on. By default it will listen to all invoice.* events.
   *
   * @example
   * ```ts
   * stripe.onInvoice({ events: ["invoice.created", "invoice.paid"] })
   * ```
   *
   * You can detect the event name in your job by using the `ctx.event.name` property:
   *
   * ```ts
   * client.defineJob({
   *   id: "stripe-example",
   *   name: "Stripe Example",
   *   version: "0.1.0",
   *   trigger: stripe.onInvoice({ events: ["invoice.created", "invoice.paid"] }),
   *   run: async (payload, io, ctx) => {
   *     console.log(ctx.event.name); // "invoice.created" or "invoice.paid"
   *   },
   * });
   * ```
   */
  onInvoice(params?: TriggerParams & { events?: InvoiceEventNames }) {
    const parsedEvents = InvoiceEventNamesSchema.optional().parse(params?.events);

    const event = {
      ...events.onInvoice,
      name: parsedEvents ?? events.onPayout.name,
    };

    return createTrigger(this.source, event, params ?? { connect: false });
  }

  /**
   * Occurs whenever an invoice is created.
   */
  onInvoiceCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceCreated, params ?? { connect: false });
  }

  /**
   * Occurs whenever an invoice is finalized.
   */
  onInvoiceFinalized(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceFinalized, params ?? { connect: false });
  }

  /**
   * The invoice couldn’t be finalized.
   */
  onInvoiceFinalizationFailed(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onInvoiceFinalizationFailed,
      params ?? { connect: false }
    );
  }

  /**
   * Occurs whenever an invoice is marked uncollectible.
   */
  onInvoiceMarkedUncollectible(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onInvoiceMarkedUncollectible,
      params ?? { connect: false }
    );
  }

  onInvoicePaid(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoicePaid, params ?? { connect: false });
  }

  onInvoicePaymentActionRequired(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onInvoicePaymentActionRequired,
      params ?? { connect: false }
    );
  }

  onInvoicePaymentFailed(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoicePaymentFailed, params ?? { connect: false });
  }

  onInvoicePaymentSucceeded(params?: TriggerParams) {
    return createTrigger(
      this.source,
      events.onInvoicePaymentSucceeded,
      params ?? { connect: false }
    );
  }

  onInvoiceSent(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceSent, params ?? { connect: false });
  }

  onInvoiceUpcoming(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceUpcoming, params ?? { connect: false });
  }

  onInvoiceUpdated(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceUpdated, params ?? { connect: false });
  }

  onInvoiceVoided(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceVoided, params ?? { connect: false });
  }

  onInvoiceItemCreated(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceItemCreated, params ?? { connect: false });
  }

  onInvoiceItemDeleted(params?: TriggerParams) {
    return createTrigger(this.source, events.onInvoiceItemDeleted, params ?? { connect: false });
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
    options: {},
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
  integration: Stripe
): ExternalSource<Stripe, { connect?: boolean }, "HTTP", {}> {
  return new ExternalSource("HTTP", {
    id: "stripe.webhook",
    schema: z.object({ connect: z.boolean().optional() }),
    version: "0.1.0",
    integration,
    key: (params) => `stripe.webhook${params.connect ? ".connect" : ""}`,
    handler: webhookHandler,
    register: async (event, io, ctx) => {
      const { params, source: httpSource, options } = event;

      const webhookData = WebhookDataSchema.safeParse(httpSource.data);

      const allEvents = Array.from(new Set([...options.event.desired, ...options.event.missing]));

      const registeredOptions = {
        event: allEvents,
      };

      if (httpSource.active && webhookData.success) {
        if (options.event.missing.length === 0) return;

        const updatedWebhook = await io.integration.updateWebhook("update-webhook", {
          id: webhookData.data.id,
          url: httpSource.url,
          enabled_events: allEvents as unknown as WebhookEvents[],
        });

        return {
          data: WebhookDataSchema.parse(updatedWebhook),
          options: registeredOptions,
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
          options: registeredOptions,
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
        options: registeredOptions,
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
      const event = await stripeClient.webhooks.constructEventAsync(rawBody, signature, source.secret);

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
