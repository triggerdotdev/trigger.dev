import { AuthenticatedTask } from "@trigger.dev/sdk";
import type {
  CreateChargeParams,
  CreateChargeResponse,
  CreateCheckoutSessionParams,
  CreateCheckoutSessionResponse,
  CreateCustomerParams,
  CreateCustomerResponse,
  CreateWebhookParams,
  CreateWebhookResponse,
  ListWebhooksParams,
  ListWebhooksResponse,
  RetrieveSubscriptionParams,
  RetrieveSubscriptionResponse,
  StripeSDK,
  UpdateCustomerParams,
  UpdateCustomerResponse,
  UpdateWebhookParams,
  UpdateWebhookResponse,
} from "./types";
import { omit } from "./utils";

/**
 * Use the [Payment Intents API](https://stripe.com/docs/api/payment_intents) to initiate a new payment instead
 * of using this method. Confirmation of the PaymentIntent creates the Charge
 * object used to request payment, so this method is limited to legacy integrations.
 */
export const createCharge: AuthenticatedTask<StripeSDK, CreateChargeParams, CreateChargeResponse> =
  {
    run: async (params, client, task) => {
      const response = await client.charges.create(params, {
        idempotencyKey: task.idempotencyKey,
        stripeAccount: params.stripeAccount,
      });

      task.outputProperties = [
        {
          label: "Charge ID",
          text: response.id,
        },
        ...(response.lastResponse.requestId
          ? [
              {
                label: "Request ID",
                text: response.lastResponse.requestId,
              },
            ]
          : []),
      ];

      return response;
    },
    init: (params) => {
      return {
        name: "Create Charge",
        params,
        icon: "stripe",
        properties: [
          {
            label: "Amount",
            text: `${params.amount}`,
          },
          ...(params.currency
            ? [
                {
                  label: "Currency",
                  text: params.currency,
                },
              ]
            : []),
          ...(params.stripeAccount
            ? [
                {
                  label: "Stripe Account",
                  text: params.stripeAccount,
                },
              ]
            : []),
        ],
      };
    },
  };

export const createCustomer: AuthenticatedTask<
  StripeSDK,
  CreateCustomerParams,
  CreateCustomerResponse
> = {
  run: async (params, client, task) => {
    const response = await client.customers.create(params, {
      idempotencyKey: task.idempotencyKey,
      stripeAccount: params.stripeAccount,
    });

    task.outputProperties = [
      {
        label: "Customer ID",
        text: response.id,
      },
      ...(response.lastResponse.requestId
        ? [
            {
              label: "Request ID",
              text: response.lastResponse.requestId,
            },
          ]
        : []),
    ];

    return response;
  },
  init: (params) => {
    return {
      name: "Create Customer",
      params,
      icon: "stripe",
      properties: [
        ...(params.stripeAccount
          ? [
              {
                label: "Stripe Account",
                text: params.stripeAccount,
              },
            ]
          : []),
      ],
    };
  },
};

/**
 * Updates the specified customer by setting the values of the parameters passed. Any parameters not provided will be left unchanged. For example, if you pass the source parameter, that becomes the customer's active source (e.g., a card) to be used for all charges in the future. When you update a customer to a new valid card source by passing the source parameter: for each of the customer's current subscriptions, if the subscription bills automatically and is in the past_due state, then the latest open invoice for the subscription with automatic collection enabled will be retried. This retry will not count as an automatic retry, and will not affect the next regularly scheduled payment for the invoice. Changing the default_source for a customer will not trigger this behavior.
 *
 * This request accepts mostly the same arguments as the customer creation call.
 */
export const updateCustomer: AuthenticatedTask<
  StripeSDK,
  UpdateCustomerParams,
  UpdateCustomerResponse
> = {
  run: async (params, client, task) => {
    const response = await client.customers.update(params.id, omit(params, "id"), {
      idempotencyKey: task.idempotencyKey,
      stripeAccount: params.stripeAccount,
    });

    task.outputProperties = [
      ...(response.lastResponse.requestId
        ? [
            {
              label: "Request ID",
              text: response.lastResponse.requestId,
            },
          ]
        : []),
    ];

    return response;
  },
  init: (params) => {
    return {
      name: "Update Customer",
      params,
      icon: "stripe",
      properties: [
        {
          label: "Customer ID",
          text: params.id,
        },
        ...(params.stripeAccount
          ? [
              {
                label: "Stripe Account",
                text: params.stripeAccount,
              },
            ]
          : []),
      ],
    };
  },
};

/**
 * Retrieves the subscription with the given ID.
 */
export const retrieveSubscription: AuthenticatedTask<
  StripeSDK,
  RetrieveSubscriptionParams,
  RetrieveSubscriptionResponse
> = {
  run: async (params, client, task) => {
    const response = await client.subscriptions.retrieve(params.id, omit(params, "id"), {
      stripeAccount: params.stripeAccount,
    });

    return response;
  },
  init: (params) => {
    return {
      name: "Retrieve Subscription",
      params,
      icon: "stripe",
      properties: [
        {
          label: "Subscription ID",
          text: params.id,
        },
        ...(params.stripeAccount
          ? [
              {
                label: "Stripe Account",
                text: params.stripeAccount,
              },
            ]
          : []),
      ],
    };
  },
};

/**
 * Creates a Session object.
 */
export const createCheckoutSession: AuthenticatedTask<
  StripeSDK,
  CreateCheckoutSessionParams,
  CreateCheckoutSessionResponse
> = {
  run: async (params, client, task) => {
    const response = await client.checkout.sessions.create(params, {
      idempotencyKey: task.idempotencyKey,
      stripeAccount: params.stripeAccount,
    });

    task.outputProperties = [
      {
        label: "Session ID",
        text: response.id,
      },
      ...(response.lastResponse.requestId
        ? [
            {
              label: "Request ID",
              text: response.lastResponse.requestId,
            },
          ]
        : []),
    ];

    return response;
  },
  init: (params) => {
    return {
      name: "Create Checkout Session",
      params,
      icon: "stripe",
      properties: [
        ...(params.stripeAccount
          ? [
              {
                label: "Stripe Account",
                text: params.stripeAccount,
              },
            ]
          : []),
      ],
    };
  },
};

export const createWebhook: AuthenticatedTask<
  StripeSDK,
  CreateWebhookParams,
  CreateWebhookResponse
> = {
  run: async (params, client, task) => {
    const response = await client.webhookEndpoints.create(params, {
      idempotencyKey: task.idempotencyKey,
    });

    task.outputProperties = [
      {
        label: "Webhook ID",
        text: response.id,
      },
      ...(response.lastResponse.requestId
        ? [
            {
              label: "Request ID",
              text: response.lastResponse.requestId,
            },
          ]
        : []),
    ];

    return response;
  },
  init: (params) => {
    return {
      name: "Create Webhook",
      params,
      icon: "stripe",
    };
  },
};

export const updateWebhook: AuthenticatedTask<
  StripeSDK,
  UpdateWebhookParams,
  UpdateWebhookResponse
> = {
  run: async (params, client, task) => {
    const response = await client.webhookEndpoints.update(params.id, omit(params, "id"), {
      idempotencyKey: task.idempotencyKey,
    });

    task.outputProperties = [
      ...(response.lastResponse.requestId
        ? [
            {
              label: "Request ID",
              text: response.lastResponse.requestId,
            },
          ]
        : []),
    ];

    return response;
  },
  init: (params) => {
    return {
      name: "Update Webhook",
      params,
      icon: "stripe",
      properties: [
        {
          label: "Webhook ID",
          text: params.id,
        },
      ],
    };
  },
};

export const listWebhooks: AuthenticatedTask<StripeSDK, ListWebhooksParams, ListWebhooksResponse> =
  {
    run: async (params, client, task) => {
      const response = await client.webhookEndpoints.list(params);

      return response;
    },
    init: (params) => {
      return {
        name: "List Webhooks",
        params,
        icon: "stripe",
      };
    },
  };
