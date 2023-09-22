import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { RetrieveSubscriptionParams, RetrieveSubscriptionResponse, StripeRunTask } from "./index";
import { omit } from "./utils";

export class Subscriptions {
  constructor(private runTask: StripeRunTask) {}

  /**
   * Retrieves the subscription with the given ID.
   */
  retrieve(
    key: IntegrationTaskKey,
    params: RetrieveSubscriptionParams
  ): Promise<RetrieveSubscriptionResponse> {
    return this.runTask(
      key,
      async (client, task) => {
        const response = await client.subscriptions.retrieve(params.id, omit(params, "id"), {
          stripeAccount: params.stripeAccount,
        });

        return response;
      },
      {
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
      }
    );
  }
}
