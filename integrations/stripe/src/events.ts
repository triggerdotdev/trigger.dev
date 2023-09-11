import type { EventSpecification } from "@trigger.dev/sdk";
import {
  amountCapturablePaymentIntentExample,
  cancelledPaymentIntentExample,
  cancelledSubscriptionExample,
  capturedChargeExample,
  checkoutSessionExample,
  createdCustomerExample,
  createdPaymentIntentExample,
  customerSubscriptionExample,
  deletedCustomerExample,
  failedChargeExample,
  failedPaymentIntentExample,
  pausedSubscriptionExample,
  refundedChargeExample,
  succeededChargeExample,
  succeededPaymentIntentExample,
  updatedAccountExample,
  updatedSubscriptionExample,
} from "./examples";
import {
  OnAccountEvent,
  OnChargeEvent,
  OnCheckoutSession,
  OnCustomerEvent,
  OnCustomerSubscription,
  OnExternalAccountEvent,
  OnPaymentIntentEvent,
  OnPayoutEvent,
  OnPersonEvent,
  OnPriceEvent,
  OnProductEvent,
} from "./types";

export const onPriceCreated: EventSpecification<OnPriceEvent> = {
  name: "price.created",
  title: "On Price Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "recurring",
      name: "Recurring Price",
      icon: "stripe",
      payload: {
        id: "price_1NYV6vI0XSgju2urKsSmI53v",
        object: "price",
        active: true,
        billing_scheme: "per_unit",
        created: 1690467853,
        currency: "usd",
        custom_unit_amount: null,
        livemode: false,
        lookup_key: null,
        metadata: {},
        nickname: null,
        product: "prod_OLBTh0QPxDXkIU",
        recurring: {
          aggregate_usage: null,
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        tax_behavior: "unspecified",
        tiers_mode: null,
        transform_quantity: null,
        type: "recurring",
        unit_amount: 1500,
        unit_amount_decimal: "1500",
      },
    },
  ],
  parsePayload: (payload) => payload as OnPriceEvent,
  runProperties: (payload) => [{ label: "Price ID", text: payload.id }],
};

export const onPriceUpdated: EventSpecification<OnPriceEvent> = {
  name: "price.updated",
  title: "On Price Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "recurring",
      name: "Recurring Price",
      icon: "stripe",
      payload: {
        id: "price_1NYVmXI0XSgju2urA56rnf3e",
        object: "price",
        active: true,
        billing_scheme: "per_unit",
        created: 1690470433,
        currency: "usd",
        custom_unit_amount: null,
        livemode: false,
        lookup_key: null,
        metadata: {
          foo: "bar",
        },
        nickname: null,
        product: "prod_OLCAdNbcBTwgEn",
        recurring: {
          aggregate_usage: null,
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        tax_behavior: "unspecified",
        tiers_mode: null,
        transform_quantity: null,
        type: "recurring",
        unit_amount: 1500,
        unit_amount_decimal: "1500",
      },
    },
  ],
  parsePayload: (payload) => payload as OnPriceEvent,
  runProperties: (payload) => [{ label: "Price ID", text: payload.id }],
};

export const onPriceDeleted: EventSpecification<OnPriceEvent> = {
  name: "price.deleted",
  title: "On Price Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "recurring",
      name: "Recurring Price",
      icon: "stripe",
      payload: {
        id: "plan_OLCbCoAUbHPcHT",
        object: "price",
        active: false,
        billing_scheme: "per_unit",
        created: 1690472058,
        currency: "usd",
        custom_unit_amount: null,
        livemode: false,
        lookup_key: null,
        metadata: {},
        nickname: null,
        product: "prod_OLCbckE3tpR34b",
        recurring: {
          aggregate_usage: null,
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        tax_behavior: "unspecified",
        tiers_mode: null,
        transform_quantity: null,
        type: "recurring",
        unit_amount: 2000,
        unit_amount_decimal: "2000",
      },
    },
  ],
  parsePayload: (payload) => payload as OnPriceEvent,
  runProperties: (payload) => [{ label: "Price ID", text: payload.id }],
};

export const onPrice: EventSpecification<OnPriceEvent> = {
  name: ["price.created", "price.updated", "price.deleted"],
  title: "On Price",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "recurring",
      name: "Recurring Price",
      icon: "stripe",
      payload: {
        id: "plan_OLCbCoAUbHPcHT",
        object: "price",
        active: false,
        billing_scheme: "per_unit",
        created: 1690472058,
        currency: "usd",
        custom_unit_amount: null,
        livemode: false,
        lookup_key: null,
        metadata: {},
        nickname: null,
        product: "prod_OLCbckE3tpR34b",
        recurring: {
          aggregate_usage: null,
          interval: "month",
          interval_count: 1,
          trial_period_days: null,
          usage_type: "licensed",
        },
        tax_behavior: "unspecified",
        tiers_mode: null,
        transform_quantity: null,
        type: "recurring",
        unit_amount: 2000,
        unit_amount_decimal: "2000",
      },
    },
  ],
  parsePayload: (payload) => payload as OnPriceEvent,
  runProperties: (payload) => [{ label: "Price ID", text: payload.id }],
};

export const onProduct: EventSpecification<OnProductEvent> = {
  name: ["product.created", "product.updated", "product.deleted"],
  title: "On Product",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "mock_product",
      name: "Mock Product",
      icon: "stripe",
      payload: {
        id: "prod_OLBTh0QPxDXkIU",
        object: "product",
        active: true,
        attributes: [],
        created: 1690467853,
        default_price: null,
        description: "(created by Stripe CLI)",
        images: [],
        livemode: false,
        metadata: {},
        name: "myproduct",
        package_dimensions: null,
        shippable: null,
        statement_descriptor: null,
        tax_code: null,
        type: "service",
        unit_label: null,
        updated: 1690467853,
        url: null,
      },
    },
  ],
  parsePayload: (payload) => payload as OnProductEvent,
  runProperties: (payload) => [{ label: "Product ID", text: payload.id }],
};

export const onProductCreated: EventSpecification<OnProductEvent> = {
  name: "product.created",
  title: "On Product Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "mock_product",
      name: "Mock Product",
      icon: "stripe",
      payload: {
        id: "prod_OLBTh0QPxDXkIU",
        object: "product",
        active: true,
        attributes: [],
        created: 1690467853,
        default_price: null,
        description: "(created by Stripe CLI)",
        images: [],
        livemode: false,
        metadata: {},
        name: "myproduct",
        package_dimensions: null,
        shippable: null,
        statement_descriptor: null,
        tax_code: null,
        type: "service",
        unit_label: null,
        updated: 1690467853,
        url: null,
      },
    },
  ],
  parsePayload: (payload) => payload as OnProductEvent,
  runProperties: (payload) => [{ label: "Product ID", text: payload.id }],
};

export const onProductUpdated: EventSpecification<OnProductEvent> = {
  name: "product.updated",
  title: "On Product Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "mock_product",
      name: "Mock Product",
      icon: "stripe",
      payload: {
        id: "prod_OLBTh0QPxDXkIU",
        object: "product",
        active: true,
        attributes: [],
        created: 1690467853,
        default_price: null,
        description: "(created by Stripe CLI)",
        images: [],
        livemode: false,
        metadata: {},
        name: "myproduct",
        package_dimensions: null,
        shippable: null,
        statement_descriptor: null,
        tax_code: null,
        type: "service",
        unit_label: null,
        updated: 1690467853,
        url: null,
      },
    },
  ],
  parsePayload: (payload) => payload as OnProductEvent,
  runProperties: (payload) => [{ label: "Product ID", text: payload.id }],
};

export const onProductDeleted: EventSpecification<OnProductEvent> = {
  name: "product.deleted",
  title: "On Product Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    {
      id: "mock_product",
      name: "Mock Product",
      icon: "stripe",
      payload: {
        id: "prod_OLBTh0QPxDXkIU",
        object: "product",
        active: true,
        attributes: [],
        created: 1690467853,
        default_price: null,
        description: "(created by Stripe CLI)",
        images: [],
        livemode: false,
        metadata: {},
        name: "myproduct",
        package_dimensions: null,
        shippable: null,
        statement_descriptor: null,
        tax_code: null,
        type: "service",
        unit_label: null,
        updated: 1690467853,
        url: null,
      },
    },
  ],
  parsePayload: (payload) => payload as OnProductEvent,
  runProperties: (payload) => [{ label: "Product ID", text: payload.id }],
};

export const onCheckoutSession: EventSpecification<OnCheckoutSession> = {
  name: [
    "checkout.session.completed",
    "checkout.session.async_payment_succeeded",
    "checkout.session.async_payment_failed",
    "checkout.session.expired",
  ],
  title: "On Checkout Session",
  source: "stripe.com",
  icon: "stripe",
  examples: [checkoutSessionExample],
  parsePayload: (payload) => payload as OnCheckoutSession,
  runProperties: (payload) => [{ label: "Session ID", text: payload.id }],
};

export const onCheckoutSessionCompleted: EventSpecification<OnCheckoutSession> = {
  name: "checkout.session.completed",
  title: "On Checkout Session Completed",
  source: "stripe.com",
  icon: "stripe",
  examples: [checkoutSessionExample],
  parsePayload: (payload) => payload as OnCheckoutSession,
  runProperties: (payload) => [{ label: "Session ID", text: payload.id }],
};

export const onCheckoutSessionExpired: EventSpecification<OnCheckoutSession> = {
  name: "checkout.session.expired",
  title: "On Checkout Session Expired",
  source: "stripe.com",
  icon: "stripe",
  examples: [checkoutSessionExample],
  parsePayload: (payload) => payload as OnCheckoutSession,
  runProperties: (payload) => [{ label: "Session ID", text: payload.id }],
};

export const onCustomerSubscription: EventSpecification<OnCustomerSubscription> = {
  name: [
    "customer.subscription.created",
    "customer.subscription.deleted",
    "customer.subscription.updated",
    "customer.subscription.paused",
    "customer.subscription.pending_update_applied",
    "customer.subscription.pending_update_expired",
    "customer.subscription.resumed",
    "customer.subscription.trial_will_end",
  ],
  title: "On Customer Subscription",
  source: "stripe.com",
  icon: "stripe",
  examples: [customerSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onCustomerSubscriptionCreated: EventSpecification<OnCustomerSubscription> = {
  name: "customer.subscription.created",
  title: "On Customer Subscription Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [customerSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onCustomerSubscriptionPaused: EventSpecification<OnCustomerSubscription> = {
  name: "customer.subscription.paused",
  title: "On Customer Subscription Paused",
  source: "stripe.com",
  icon: "stripe",
  examples: [pausedSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onCustomerSubscriptionResumed: EventSpecification<OnCustomerSubscription> = {
  name: "customer.subscription.resumed",
  title: "On Customer Subscription Resumed",
  source: "stripe.com",
  icon: "stripe",
  examples: [customerSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onCustomerSubscriptionDeleted: EventSpecification<OnCustomerSubscription> = {
  name: "customer.subscription.deleted",
  title: "On Customer Subscription Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [cancelledSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onCustomerSubscriptionUpdated: EventSpecification<OnCustomerSubscription> = {
  name: "customer.subscription.updated",
  title: "On Customer Subscription Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [updatedSubscriptionExample],
  parsePayload: (payload) => payload as OnCustomerSubscription,
  runProperties: (payload) => [
    { label: "Subscription ID", text: payload.id },
    { label: "Status", text: payload.status },
  ],
};

export const onAccountUpdated: EventSpecification<OnAccountEvent> = {
  name: "account.updated",
  title: "On Account Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [updatedAccountExample],
  parsePayload: (payload) => payload as OnAccountEvent,
  runProperties: (payload) => [
    { label: "Account ID", text: payload.id },
    ...(payload.business_type ? [{ label: "Business Type", text: payload.business_type }] : []),
  ],
};

export const onCustomer: EventSpecification<OnCustomerEvent> = {
  name: ["customer.created", "customer.deleted", "customer.updated"],
  title: "On Customer Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [createdCustomerExample],
  parsePayload: (payload) => payload as OnCustomerEvent,
  runProperties: (payload) => [{ label: "Customer ID", text: payload.id }],
};

export const onCustomerCreated: EventSpecification<OnCustomerEvent> = {
  name: "customer.created",
  title: "On Customer Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [createdCustomerExample],
  parsePayload: (payload) => payload as OnCustomerEvent,
  runProperties: (payload) => [{ label: "Customer ID", text: payload.id }],
};

export const onCustomerDeleted: EventSpecification<OnCustomerEvent> = {
  name: "customer.deleted",
  title: "On Customer Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [deletedCustomerExample],
  parsePayload: (payload) => payload as OnCustomerEvent,
  runProperties: (payload) => [{ label: "Customer ID", text: payload.id }],
};

export const onCustomerUpdated: EventSpecification<OnCustomerEvent> = {
  name: "customer.updated",
  title: "On Customer Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [createdCustomerExample],
  parsePayload: (payload) => payload as OnCustomerEvent,
  runProperties: (payload) => [{ label: "Customer ID", text: payload.id }],
};

export const onCharge: EventSpecification<OnChargeEvent> = {
  name: [
    "charge.captured",
    "charge.expired",
    "charge.failed",
    "charge.pending",
    "charge.refunded",
    "charge.succeeded",
    "charge.updated",
  ],
  title: "On Charge Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    capturedChargeExample,
    succeededChargeExample,
    failedChargeExample,
    refundedChargeExample,
  ],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeCaptured: EventSpecification<OnChargeEvent> = {
  name: "charge.captured",
  title: "On Charge Captured",
  source: "stripe.com",
  icon: "stripe",
  examples: [capturedChargeExample],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeExpired: EventSpecification<OnChargeEvent> = {
  name: "charge.expired",
  title: "On Charge Expired",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeFailed: EventSpecification<OnChargeEvent> = {
  name: "charge.failed",
  title: "On Charge Failed",
  source: "stripe.com",
  icon: "stripe",
  examples: [failedChargeExample],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargePending: EventSpecification<OnChargeEvent> = {
  name: "charge.pending",
  title: "On Charge Pending",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeRefunded: EventSpecification<OnChargeEvent> = {
  name: "charge.refunded",
  title: "On Charge Refunded",
  source: "stripe.com",
  icon: "stripe",
  examples: [refundedChargeExample],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeSucceeded: EventSpecification<OnChargeEvent> = {
  name: "charge.succeeded",
  title: "On Charge Succeeded",
  source: "stripe.com",
  icon: "stripe",
  examples: [succeededChargeExample],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onChargeUpdated: EventSpecification<OnChargeEvent> = {
  name: "charge.updated",
  title: "On Charge Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnChargeEvent,
  runProperties: (payload) => [{ label: "Charge ID", text: payload.id }],
};

export const onExternalAccount: EventSpecification<OnExternalAccountEvent> = {
  name: [
    "account.external_account.created",
    "account.external_account.deleted",
    "account.external_account.updated",
  ],
  title: "On External Account Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnExternalAccountEvent,
  runProperties: (payload) => [
    { label: "Type", text: payload.object },
    { label: payload.object === "bank_account" ? "Bank Account ID" : "Card ID", text: payload.id },
  ],
};

export const onExternalAccountCreated: EventSpecification<OnExternalAccountEvent> = {
  name: "account.external_account.created",
  title: "On External Account Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnExternalAccountEvent,
  runProperties: (payload) => [
    { label: "Type", text: payload.object },
    { label: payload.object === "bank_account" ? "Bank Account ID" : "Card ID", text: payload.id },
  ],
};

export const onExternalAccountDeleted: EventSpecification<OnExternalAccountEvent> = {
  name: "account.external_account.deleted",
  title: "On External Account Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnExternalAccountEvent,
  runProperties: (payload) => [
    { label: "Type", text: payload.object },
    { label: payload.object === "bank_account" ? "Bank Account ID" : "Card ID", text: payload.id },
  ],
};

export const onExternalAccountUpdated: EventSpecification<OnExternalAccountEvent> = {
  name: "account.external_account.updated",
  title: "On External Account Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnExternalAccountEvent,
  runProperties: (payload) => [
    { label: "Type", text: payload.object },
    { label: payload.object === "bank_account" ? "Bank Account ID" : "Card ID", text: payload.id },
  ],
};

export const onPerson: EventSpecification<OnPersonEvent> = {
  name: ["person.created", "person.deleted", "person.updated"],
  title: "On Person Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPersonEvent,
  runProperties: (payload) => [
    { label: "Person ID", text: payload.id },
    { label: "Account", text: payload.account },
  ],
};

export const onPersonCreated: EventSpecification<OnPersonEvent> = {
  name: "person.created",
  title: "On Person Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPersonEvent,
  runProperties: (payload) => [
    { label: "Person ID", text: payload.id },
    { label: "Account", text: payload.account },
  ],
};

export const onPersonDeleted: EventSpecification<OnPersonEvent> = {
  name: "person.deleted",
  title: "On Person Deleted",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPersonEvent,
  runProperties: (payload) => [
    { label: "Person ID", text: payload.id },
    { label: "Account", text: payload.account },
  ],
};

export const onPersonUpdated: EventSpecification<OnPersonEvent> = {
  name: "person.updated",
  title: "On Person Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPersonEvent,
  runProperties: (payload) => [
    { label: "Person ID", text: payload.id },
    { label: "Account", text: payload.account },
  ],
};

export const onPaymentIntent: EventSpecification<OnPaymentIntentEvent> = {
  name: [
    "payment_intent.created",
    "payment_intent.succeeded",
    "payment_intent.canceled",
    "payment_intent.processing",
    "payment_intent.requires_action",
    "payment_intent.amount_capturable_updated",
    "payment_intent.payment_failed",
    "payment_intent.partially_funded",
  ],
  title: "On Payment Intent Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [
    createdPaymentIntentExample,
    succeededPaymentIntentExample,
    cancelledPaymentIntentExample,
    amountCapturablePaymentIntentExample,
    failedPaymentIntentExample,
  ],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentCreated: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.created",
  title: "On Payment Intent Created",
  source: "stripe.com",
  icon: "stripe",
  examples: [createdPaymentIntentExample],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentSucceeded: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.succeeded",
  title: "On Payment Intent Succeeded",
  source: "stripe.com",
  icon: "stripe",
  examples: [succeededPaymentIntentExample],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentCanceled: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.canceled",
  title: "On Payment Intent Canceled",
  source: "stripe.com",
  icon: "stripe",
  examples: [cancelledPaymentIntentExample],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentProcessing: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.processing",
  title: "On Payment Intent Processing",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentRequiresAction: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.requires_action",
  title: "On Payment Intent Requires Action",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentAmountCapturableUpdated: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.amount_capturable_updated",
  title: "On Payment Intent Amount Capturable Updated",
  source: "stripe.com",
  icon: "stripe",
  examples: [amountCapturablePaymentIntentExample],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentPaymentFailed: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.payment_failed",
  title: "On Payment Intent Payment Failed",
  source: "stripe.com",
  icon: "stripe",
  examples: [failedPaymentIntentExample],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPaymentIntentPartiallyFunded: EventSpecification<OnPaymentIntentEvent> = {
  name: "payment_intent.partially_funded",
  title: "On Payment Intent Partially Funded",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPaymentIntentEvent,
  runProperties: (payload) => [{ label: "Payment Intent ID", text: payload.id }],
};

export const onPayout: EventSpecification<OnPayoutEvent> = {
  name: [
    "payout.canceled",
    "payout.created",
    "payout.failed",
    "payout.paid",
    "payout.reconciliation_completed",
    "payout.updated",
  ],
  title: "On Payout Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutCancelled: EventSpecification<OnPayoutEvent> = {
  name: "payout.canceled",
  title: "On Payout Cancelled Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutCreated: EventSpecification<OnPayoutEvent> = {
  name: "payout.created",
  title: "On Payout Created Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutFailed: EventSpecification<OnPayoutEvent> = {
  name: "payout.failed",
  title: "On Payout Failed Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutPaid: EventSpecification<OnPayoutEvent> = {
  name: "payout.paid",
  title: "On Payout Paid Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutReconciliationCompleted: EventSpecification<OnPayoutEvent> = {
  name: "payout.reconciliation_completed",
  title: "On Payout Reconciliation Completed Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};

export const onPayoutUpdated: EventSpecification<OnPayoutEvent> = {
  name: "payout.updated",
  title: "On Payout Updated Event",
  source: "stripe.com",
  icon: "stripe",
  examples: [],
  parsePayload: (payload) => payload as OnPayoutEvent,
  runProperties: (payload) => [
    { label: "Payout ID", text: payload.id },
    { label: "Amount", text: `${payload.amount} ${payload.currency}` },
  ],
};
