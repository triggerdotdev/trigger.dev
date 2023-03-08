import { validate } from "core/schemas/validate";
import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import { webhooks, events } from "../webhooks/webhooks";

const authToken = () => process.env.STRIPE_API_KEY ?? "";

describe("stripe.webhooks", async () => {
  test("subscribe", async () => {
    const accessToken = authToken();

    const subscription = webhooks.webhook.subscription;
    expect(subscription.type).toEqual("automatic");
    if (subscription.type !== "automatic") {
      throw new Error("Invalid subscription type");
    }

    const nockDone = await startNock("stripe.webhook.subscribe");
    const result = await subscription.subscribe({
      webhookId: "abcdefghijklmnopqrstuvwxyz",
      callbackUrl: "https://example.com",
      events: ["checkout.session.completed"],
      secret: "123456",
      inputData: {},
      credentials: {
        type: "api_key",
        name: "apiKey",
        api_key: accessToken,
        scopes: ["webhooks:write"],
      },
    });

    expect(result.success).toEqual(true);
    expect(result).toMatchInlineSnapshot(`
      {
        "callbackUrl": "https://example.com",
        "data": {
          "api_version": null,
          "application": null,
          "created": 1678197569,
          "description": "Trigger.dev webhook for events checkout.session.completed",
          "enabled_events": [
            "checkout.session.completed",
          ],
          "id": "we_1Mj137GHlQRWA8CggGfaBkhz",
          "livemode": false,
          "metadata": {},
          "object": "webhook_endpoint",
          "secret": "whsec_4gm8qR9cYScNcvMZKUgwhtkzwoNY0NhB",
          "status": "enabled",
          "url": "https://example.com",
        },
        "events": [
          "checkout.session.completed",
        ],
        "headers": {
          "access-control-allow-credentials": "true",
          "access-control-allow-methods": "GET, POST, HEAD, OPTIONS, DELETE",
          "access-control-allow-origin": "*",
          "access-control-expose-headers": "Request-Id, Stripe-Manage-Version, X-Stripe-External-Auth-Required, X-Stripe-Privileged-Session-Required",
          "access-control-max-age": "300",
          "cache-control": "no-cache, no-store",
          "connection": "close",
          "content-length": "430",
          "content-type": "application/json",
          "date": "Tue, 07 Mar 2023 13:59:29 GMT",
          "idempotency-key": "e8ac06e5-f582-4e18-9efa-ed0c9348df02",
          "original-request": "req_wat7ygbANPveOQ",
          "request-id": "req_wat7ygbANPveOQ",
          "server": "nginx",
          "strict-transport-security": "max-age=63072000; includeSubDomains; preload",
          "stripe-should-retry": "false",
          "stripe-version": "2022-11-15",
        },
        "secret": "whsec_4gm8qR9cYScNcvMZKUgwhtkzwoNY0NhB",
        "status": 200,
        "success": true,
      }
    `);
    stopNock(nockDone);
  });

  // test("receiving (correct signature)", async () => {
  //   const accessToken = authToken();

  //   //explicitly pass in a payload (this is hardcoded, not from a request)
  //   try {
  //     const result = await webhooks.webhook.receive({
  //       credentials: {
  //         type: "api_key",
  //         name: "apiKey",
  //         api_key: accessToken,
  //         scopes: ["webhooks:write"],
  //       },
  //       secret: "123456",
  //       subscriptionData: {
  //         id: "01GTH8BG8S4KK1XW38SNDN1SRV",
  //         form_id: "NclFXN1d",
  //         tag: "myTag",
  //         url: "https://example.com",
  //         enabled: true,
  //         verify_ssl: true,
  //         secret: "123456",
  //         created_at: "2023-03-02T13:32:00.154368Z",
  //         updated_at: "2023-03-02T15:08:01.697884Z",
  //       },
  //       request: {
  //         method: "POST",
  //         searchParams: new URLSearchParams(),
  //         headers: {
  //           "content-type": "application/json",
  //           "typeform-signature":
  //             "sha256=VsvwNrh0fT5VWF+05H3azXZXJyFkhHTtONMxIVm6PZ4=",
  //         },
  //         body: events.checkoutCompleted.examples[0],
  //         rawBody: Buffer.from(JSON.stringify(events.checkoutCompleted.examples[0])),
  //       },
  //     });

  //     expect(result).toMatchInlineSnapshot();
  //   } catch (e) {
  //     console.error(e);
  //     expect(true).toBe(false);
  //   }
  // });

  // test("receiving (bad signature)", async () => {
  //   const accessToken = authToken();

  //   //explicitly pass in a payload (this is hardcoded, not from a request)
  //   try {
  //     const result = await webhooks.formResponse.receive({
  //       credentials: {
  //         type: "api_key",
  //         name: "accessToken",
  //         api_key: accessToken,
  //         scopes: ["webhooks:write"],
  //       },
  //       secret: "123",
  //       subscriptionData: {
  //         id: "01GTH8BG8S4KK1XW38SNDN1SRV",
  //         form_id: "NclFXN1d",
  //         tag: "myTag",
  //         url: "https://example.com",
  //         enabled: true,
  //         verify_ssl: true,
  //         secret: "123456",
  //         created_at: "2023-03-02T13:32:00.154368Z",
  //         updated_at: "2023-03-02T15:08:01.697884Z",
  //       },
  //       request: {
  //         method: "POST",
  //         searchParams: new URLSearchParams(),
  //         headers: {
  //           "content-type": "application/json",
  //           "typeform-signature":
  //             "sha256=VsvwNrh0fT5VWF+05H3azXZXJyFkhHTtONMxIVm6PZ4=",
  //         },
  //         body: events.formResponse.examples[0],
  //         rawBody: Buffer.from(JSON.stringify(events.formResponse.examples[0])),
  //       },
  //     });

  //     expect(result).toMatchInlineSnapshot(`
  //       {
  //         "error": "Invalid signature",
  //         "response": {
  //           "headers": {},
  //           "status": 401,
  //         },
  //         "success": false,
  //       }
  //     `);
  //   } catch (e) {
  //     console.error(e);
  //     expect(true).toBe(false);
  //   }
  // });

  describe("schemas", async () => {
    test("check 1", async () => {
      const data = events.checkoutCompleted.examples[0];

      const validationResult = await validate(
        data,
        events.checkoutCompleted.schema
      );
      expect(validationResult).toEqual({
        success: true,
      });
    });
  });
});
