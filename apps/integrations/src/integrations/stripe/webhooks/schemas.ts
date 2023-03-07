import {
  makeBooleanSchema,
  makeNullable,
  makeNumberSchema,
  makeObjectSchema,
  makeStringSchema,
} from "core/schemas/makeSchema";
import { JSONSchema } from "core/schemas/types";

export const checkoutSessionCompletedSchema: JSONSchema = makeObjectSchema(
  "Checkout Session Completed",
  {
    requiredProperties: {
      id: makeStringSchema("ID", "Unique identifier for the object."),
      cancel_url: makeNullable(
        makeStringSchema(
          "Cancel URL",
          "If set, Checkout displays a back button and customers will be directed to this URL if they decide to cancel payment and return to your website."
        )
      ),
      client_reference_id: makeNullable(
        makeStringSchema(
          "Client Reference ID",
          "A unique string to reference the Checkout Session. This can be a customer ID, a cart ID, or similar, and can be used to reconcile the Session with your internal systems."
        )
      ),
      currency: makeStringSchema("Currency", "ISO currency code"),
      customer: makeNullable(
        makeStringSchema(
          "Customer",
          "The ID of the customer for this Session. For Checkout Sessions in payment or subscription mode, Checkout will create a new customer object based on information provided during the payment flow unless an existing customer was provided when the Session was created."
        )
      ),
      customer_email: makeNullable(
        makeStringSchema(
          "Customer Email",
          "If provided, this value will be used when the Customer object is created. If not provided, customers will be asked to enter their email address. Use this parameter to prefill customer data if you already have an email on file. To access information about the customer once the payment flow is complete, use the customer attribute."
        )
      ),
      mode: makeStringSchema(
        "Mode",
        "Specifies which fields in the response should be expanded.",
        {
          enum: ["payment", "setup", "subscription"],
        }
      ),
      payment_intent: makeNullable(
        makeStringSchema(
          "Payment Intent",
          "The ID of the PaymentIntent for Checkout Sessions in payment mode."
        )
      ),
      payment_status: makeStringSchema(
        "Payment Status",
        "The status of the payment. One of paid, unpaid, or no_payment_required. You can use this value to decide when to fulfill your customer’s order.",
        {
          enum: ["paid", "unpaid", "no_payment_required"],
        }
      ),
      status: makeStringSchema(
        "Status",
        "The status of the Checkout Session, one of open, complete, or expired.",
        {
          enum: ["open", "complete", "expired"],
        }
      ),
      success_url: makeNullable(
        makeStringSchema(
          "Success URL",
          "The URL the customer will be directed to after the payment or subscription creation is successful."
        )
      ),
      object: makeStringSchema(
        "Object",
        "String representing the object’s type. Objects of the same type share the same value.",
        {
          const: "checkout.session",
        }
      ),
      after_expiration: makeNullable(
        makeObjectSchema("After Expiration", {
          requiredProperties: {
            recovery: makeObjectSchema("Recovery", {
              optionalProperties: {
                allow_promotion_codes: makeBooleanSchema(
                  "Allow Promotion Codes",
                  "Enables user redeemable promotion codes on the recovered Checkout Sessions. Defaults to false."
                ),
                enabled: makeBooleanSchema(
                  "Enabled",
                  "If true, a recovery url will be generated to recover this Checkout Session if it expires before a transaction is completed. It will be attached to the Checkout Session object upon expiration."
                ),
                expires_at: makeNullable(
                  makeNumberSchema(
                    "Expires At",
                    "The timestamp at which the recovery URL will expire."
                  )
                ),
                url: makeNullable(
                  makeStringSchema(
                    "URL",
                    "The URL to the Checkout Session. Redirect customers to this URL to take them to Checkout. If you’re using Custom Domains, the URL will use your subdomain. Otherwise, it’ll use checkout.stripe.com. This value is only present when the session is active."
                  )
                ),
              },
            }),
          },
        })
      ),
      allow_promotion_codes: makeNullable(
        makeBooleanSchema(
          "Allow Promotion Codes",
          "Enables user redeemable promotion codes."
        )
      ),
      amount_,
    },
    optionalProperties: {
      url: makeNullable(
        makeStringSchema(
          "URL",
          "The URL to the Checkout Session. Redirect customers to this URL to take them to Checkout. If you’re using Custom Domains, the URL will use your subdomain. Otherwise, it’ll use checkout.stripe.com. This value is only present when the session is active."
        )
      ),
    },
  }
);
