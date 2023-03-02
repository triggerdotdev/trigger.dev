import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import webhooks from "../webhooks/webhooks";

const authToken = () => process.env.TYPEFORM_ACCESS_TOKEN ?? "";

describe("typeform.webhooks", async () => {
  test("subscribe", async () => {
    const accessToken = authToken();

    // const nockDone = await startNock("typeform.webhook.subscribe");

    try {
      const result = await webhooks.formResponse.subscribe({
        callbackUrl: "https://example.com",
        events: ["form_response"],
        secret: "secret",
        data: {
          form_id: "NclFXN1d",
          tag: "myTag",
        },
        credentials: {
          type: "api_key",
          name: "accessToken",
          api_key: accessToken,
          scopes: ["webhooks:write"],
        },
      });

      console.log(result);
      expect(result.success).toEqual(true);
      // stopNock(nockDone);
    } catch (e) {
      console.error(e);
      expect(true).toBe(false);
    }
  });
});
