import { z } from "zod";

export const PriceEventNamesSchema = z.array(
  z.enum(["price.created", "price.updated", "price.deleted"])
);
export type PriceEventNames = z.infer<typeof PriceEventNamesSchema>;

export const ProductEventNamesSchema = z.array(
  z.enum(["product.created", "product.updated", "product.deleted"])
);
export type ProductEventNames = z.infer<typeof ProductEventNamesSchema>;

export const CheckoutSessionEventNamesSchema = z.array(
  z.enum([
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ])
);
export type CheckoutSessionEventNames = z.infer<typeof CheckoutSessionEventNamesSchema>;

export const CustomerSubscriptionEventNamesSchema = z.array(
  z.enum([
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "customer.subscription.paused",
    "customer.subscription.pending_update_applied",
    "customer.subscription.pending_update_expired",
    "customer.subscription.resumed",
  ])
);
export type CustomerSubscriptionEventNames = z.infer<typeof CustomerSubscriptionEventNamesSchema>;

export const CustomerEventNamesSchema = z.array(
  z.enum(["customer.created", "customer.updated", "customer.deleted"])
);
export type CustomerEventNames = z.infer<typeof CustomerEventNamesSchema>;

export const ChargeEventNamesSchema = z.array(
  z.enum([
    "charge.captured",
    "charge.expired",
    "charge.failed",
    "charge.pending",
    "charge.refunded",
    "charge.succeeded",
    "charge.updated",
  ])
);
export type ChargeEventNames = z.infer<typeof ChargeEventNamesSchema>;

export const ExternalAccountEventNamesSchema = z.array(
  z.enum([
    "account.external_account.created",
    "account.external_account.updated",
    "account.external_account.deleted",
  ])
);
export type ExternalAccountEventNames = z.infer<typeof ExternalAccountEventNamesSchema>;

export const PersonEventNamesSchema = z.array(
  z.enum(["person.created", "person.updated", "person.deleted"])
);
export type PersonEventNames = z.infer<typeof PersonEventNamesSchema>;

export const PaymentIntentEventNamesSchema = z.array(
  z.enum([
    "payment_intent.created",
    "payment_intent.succeeded",
    "payment_intent.canceled",
    "payment_intent.processing",
    "payment_intent.requires_action",
    "payment_intent.amount_capturable_updated",
    "payment_intent.payment_failed",
    "payment_intent.partially_funded",
  ])
);
export type PaymentIntentEventNames = z.infer<typeof PaymentIntentEventNamesSchema>;

export const PayoutEventNamesSchema = z.array(
  z.enum([
    "payout.canceled",
    "payout.created",
    "payout.failed",
    "payout.paid",
    "payout.reconciliation_completed",
    "payout.updated",
  ])
);
export type PayoutEventNames = z.infer<typeof PayoutEventNamesSchema>;

export const InvoiceEventNamesSchema = z.array(
  z.enum([
    "invoice.created",
    "invoice.finalized",
    "invoice.finalization_failed",
    "invoice.deleted",
    "invoice.marked_uncollectible",
    "invoice.paid",
    "invoice.payment_action_required",
    "invoice.payment_failed",
    "invoice.payment_succeeded",
    "invoice.sent",
    "invoice.upcoming",
    "invoice.voided",
  ])
);
export type InvoiceEventNames = z.infer<typeof InvoiceEventNamesSchema>;
