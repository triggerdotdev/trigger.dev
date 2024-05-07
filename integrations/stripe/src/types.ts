/// <reference types="stripe-event-types" />
import { Stripe } from "stripe";
import { Prettify } from "@trigger.dev/integration-kit";

export type StripeSDK = Stripe;

export type StripeIntegrationOptions = {
  id: string;
  apiKey?: string;

  /**
   * An account id on whose behalf you wish to make every request.
   */
  stripeAccount?: string;
};

type WithStripeConnectOptions<T> = T & {
  stripeAccount?: string;
};

export type CreateChargeParams = Prettify<WithStripeConnectOptions<Stripe.ChargeCreateParams>>;
export type CreateChargeResponse = Prettify<Stripe.Response<Stripe.Charge>>;

export type CreateCustomerParams = Prettify<WithStripeConnectOptions<Stripe.CustomerCreateParams>>;

export type CreateCustomerResponse = Prettify<Stripe.Response<Stripe.Customer>>;

export type UpdateCustomerParams = Prettify<
  WithStripeConnectOptions<Stripe.CustomerUpdateParams & { id: string }>
>;

export type UpdateCustomerResponse = Prettify<Stripe.Response<Stripe.Customer>>;

export type RetrieveSubscriptionParams = Prettify<
  WithStripeConnectOptions<Stripe.SubscriptionRetrieveParams & { id: string }>
>;

export type RetrieveSubscriptionResponse = Prettify<Stripe.Response<Stripe.Subscription>>;

export type CreateCheckoutSessionParams = Prettify<
  WithStripeConnectOptions<Stripe.Checkout.SessionCreateParams>
>;

export type CreateCheckoutSessionResponse = Prettify<Stripe.Response<Stripe.Checkout.Session>>;

export type CreateWebhookParams = Prettify<Stripe.WebhookEndpointCreateParams>;

export type CreateWebhookResponse = Prettify<Stripe.WebhookEndpoint>;

export type UpdateWebhookParams = Prettify<Stripe.WebhookEndpointUpdateParams & { id: string }>;

export type UpdateWebhookResponse = Prettify<Stripe.WebhookEndpoint>;

export type WebhookEvents = Exclude<Stripe.WebhookEndpointUpdateParams.EnabledEvent, "*">;

export type ListWebhooksParams = Prettify<Stripe.WebhookEndpointListParams>;

export type ListWebhooksResponse = Prettify<
  Stripe.Response<Stripe.ApiList<Stripe.WebhookEndpoint>>
>;

type ExtractWebhookPayload<T extends Stripe.DiscriminatedEvent> = Prettify<T["data"]["object"]>;

export type OnPriceEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.PriceEvent>;

export type OnProductEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.ProductEvent>;

export type OnCheckoutSession =
  ExtractWebhookPayload<Stripe.DiscriminatedEvent.CheckoutSessionEvent>;

export type OnCustomerSubscription =
  ExtractWebhookPayload<Stripe.DiscriminatedEvent.CustomerSubscriptionEvent>;

export type OnAccountEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.AccountEvent>;

export type OnCustomerEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.CustomerEvent>;

export type OnChargeEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.ChargeEvent>;

export type OnExternalAccountEvent =
  ExtractWebhookPayload<Stripe.DiscriminatedEvent.AccountExternalAccountEvent>;

export type OnPersonEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.PersonEvent>;

export type OnPaymentIntentEvent =
  ExtractWebhookPayload<Stripe.DiscriminatedEvent.PaymentIntentEvent>;

export type OnPayoutEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.PayoutEvent>;

export type OnInvoiceEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.InvoiceEvent>;

export type OnInvoiceItemEvent = ExtractWebhookPayload<Stripe.DiscriminatedEvent.InvoiceitemEvent>;
