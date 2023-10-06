import { IntegrationTaskKey } from "@trigger.dev/sdk";
import {
  CreateCustomerParams,
  CreateCustomerResponse,
  StripeRunTask,
  UpdateCustomerParams,
  UpdateCustomerResponse,
} from "./index";
import { omit } from "./utils";

export class Customers {
  constructor(private runTask: StripeRunTask) {}

  create(key: IntegrationTaskKey, params: CreateCustomerParams): Promise<CreateCustomerResponse> {
    return this.runTask(
      key,
      async (client, task) => {
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
      {
        name: "Create Customer",
        params,
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
      }
    );
  }

  /**
   * Updates the specified customer by setting the values of the parameters passed. Any parameters not provided will be left unchanged. For example, if you pass the source parameter, that becomes the customer's active source (e.g., a card) to be used for all charges in the future. When you update a customer to a new valid card source by passing the source parameter: for each of the customer's current subscriptions, if the subscription bills automatically and is in the past_due state, then the latest open invoice for the subscription with automatic collection enabled will be retried. This retry will not count as an automatic retry, and will not affect the next regularly scheduled payment for the invoice. Changing the default_source for a customer will not trigger this behavior.
   *
   * This request accepts mostly the same arguments as the customer creation call.
   */
  update(key: IntegrationTaskKey, params: UpdateCustomerParams): Promise<UpdateCustomerResponse> {
    return this.runTask(
      key,
      async (client, task) => {
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
      {
        name: "Update Customer",
        params,
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
      }
    );
  }
}
