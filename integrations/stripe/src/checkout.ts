import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { CreateCheckoutSessionParams, CreateCheckoutSessionResponse, StripeRunTask } from "./index";

export class Checkout {
  constructor(private runTask: StripeRunTask) {}

  sessions = {
    /**
     * Creates a Session object.
     */
    create: (
      key: IntegrationTaskKey,
      params: CreateCheckoutSessionParams
    ): Promise<CreateCheckoutSessionResponse> => {
      return this.runTask(
        key,
        async (client, task) => {
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
        {
          name: "Create Checkout Session",
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
    },
  };
}
