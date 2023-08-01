import type { EventSpecification } from "@trigger.dev/sdk";
import {
  cancelledSubscriptionExample,
  checkoutSessionExample,
  customerSubscriptionExample,
  pausedSubscriptionExample,
  updatedSubscriptionExample,
} from "./examples";
import { OnCheckoutSession, OnCustomerSubscription, OnPriceEvent, OnProductEvent } from "./types";

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
