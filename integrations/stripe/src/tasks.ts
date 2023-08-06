import type {
  StripeSDK,
  CreateChargeParams,
  CreateChargeResponse,
  CreateCustomerResponse,
  CreateCustomerParams,
  UpdateCustomerParams,
  UpdateCustomerResponse,
  RetrieveSubscriptionParams,
  RetrieveSubscriptionResponse,
  CreateCheckoutSessionParams,
  CreateCheckoutSessionResponse,
  CreateWebhookParams,
  CreateWebhookResponse,
  UpdateWebhookParams,
  UpdateWebhookResponse,
  ListWebhooksResponse,
  ListWebhooksParams,
} from "./types";
import { AuthenticatedTask } from "@trigger.dev/sdk";
import { Stripe } from "stripe";
import { omit } from "./utils";

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
