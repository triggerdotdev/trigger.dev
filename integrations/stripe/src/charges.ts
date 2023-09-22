import { IntegrationTaskKey } from "@trigger.dev/sdk";
import { CreateChargeParams, CreateChargeResponse, StripeRunTask } from "./index";

export class Charges {
  constructor(private runTask: StripeRunTask) {}

  /**
   * Use the [Payment Intents API](https://stripe.com/docs/api/payment_intents) to initiate a new payment instead
   * of using this method. Confirmation of the PaymentIntent creates the Charge
   * object used to request payment, so this method is limited to legacy integrations.
   */
  create(key: IntegrationTaskKey, params: CreateChargeParams): Promise<CreateChargeResponse> {
    return this.runTask(
      key,
      async (client, task) => {
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
      {
        name: "Create Charge",
        params,
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
      }
    );
  }
}
