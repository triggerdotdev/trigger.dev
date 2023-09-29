import { createExpressServer } from "@trigger.dev/express";
import { TriggerClient, eventTrigger } from "@trigger.dev/sdk";
import { z } from "zod";

export const client = new TriggerClient({
  id: "job-catalog",
  apiKey: process.env["TRIGGER_API_KEY"],
  apiUrl: process.env["TRIGGER_API_URL"],
  verbose: false,
  ioLogLocalEnabled: true,
});

client.defineJob({
  id: "redaction-example-1",
  name: "Redaction Example 1",
  version: "1.0.0",
  enabled: true,
  trigger: eventTrigger({
    name: "redaction.example",
  }),
  run: async (payload, io, ctx) => {
    const result = await io.runTask(
      "task-example-1",
      async () => {
        return {
          id: "evt_3NYWgVI0XSgju2ur0PN22Hsu",
          object: "event",
          api_version: "2022-11-15",
          created: 1690473903,
          data: {
            object: {
              id: "ch_3NYWgVI0XSgju2ur0C2UzeKC",
              object: "charge",
              amount: 1500,
              amount_captured: 1500,
              amount_refunded: 0,
              application: null,
              application_fee: null,
              application_fee_amount: null,
              balance_transaction: "txn_3NYWgVI0XSgju2ur0qujz4Kc",
              billing_details: {
                address: {
                  city: null,
                  country: null,
                  line1: null,
                  line2: null,
                  postal_code: null,
                  state: null,
                },
                email: null,
                name: null,
                phone: null,
              },
              calculated_statement_descriptor: "WWW.TRIGGER.DEV",
              captured: true,
              created: 1690473903,
              currency: "usd",
              customer: "cus_OLD6IR3D8CJasG",
              description: "Subscription creation",
              destination: null,
              dispute: null,
              disputed: false,
              failure_balance_transaction: null,
              failure_code: null,
              failure_message: null,
              fraud_details: {},
              invoice: "in_1NYWgUI0XSgju2urV5ZTEyIn",
              livemode: false,
              metadata: {},
              on_behalf_of: null,
              order: null,
              outcome: {
                network_status: "approved_by_network",
                reason: null,
                risk_level: "normal",
                risk_score: 61,
                seller_message: "Payment complete.",
                type: "authorized",
              },
              paid: true,
              payment_intent: "pi_3NYWgVI0XSgju2ur0fWNLexG",
              payment_method: "pm_1NYWgTI0XSgju2urW3aXpinM",
              payment_method_details: {
                card: {
                  brand: "visa",
                  checks: {
                    address_line1_check: null,
                    address_postal_code_check: null,
                    cvc_check: null,
                  },
                  country: "US",
                  exp_month: 7,
                  exp_year: 2024,
                  fingerprint: "w6qgKDLO5EbIJ5VZ",
                  funding: "credit",
                  installments: null,
                  last4: "4242",
                  mandate: null,
                  network: "visa",
                  network_token: {
                    used: false,
                  },
                  three_d_secure: null,
                  wallet: null,
                },
                type: "card",
              },
              receipt_email: null,
              receipt_number: null,
              receipt_url:
                "https://pay.stripe.com/receipts/invoices/CAcaFwoVYWNjdF8xTVJtRzRJMFhTZ2p1MnVyKLCriqYGMga_ozxgMkA6LBbrKccthI_hGdug_gXtuu_piRAvzyNVaH_aMq9mUTOl3VdNbfcH7nhFjK08?s=ap",
              refunded: false,
              review: null,
              shipping: null,
              source: null,
              source_transfer: null,
              statement_descriptor: null,
              statement_descriptor_suffix: null,
              status: "succeeded",
              transfer_data: null,
              transfer_group: null,
            },
          },
          livemode: false,
          pending_webhooks: 2,
          request: {
            id: "req_vtwGrzB2O98Pnc",
            idempotency_key: "215856c0-4f06-48eb-94c6-7ed4e839d7bc",
          },
          type: "charge.succeeded",
        };
      },
      {
        redact: {
          paths: [
            "data.object.balance_transaction",
            "data.object.billing_details",
            "data.object.this_does_not_exist",
            "data.object.$$$$hello",
          ],
        },
      }
    );

    await io.logger.info("Log.1", { ctx, result });

    await io.wait("wait-1", 1);

    await io.logger.info("Log.2", { ctx, result });
  },
});

createExpressServer(client);
