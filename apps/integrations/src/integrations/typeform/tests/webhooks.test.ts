import { startNock, stopNock } from "testing/nock";
import { describe, expect, test } from "vitest";
import webhooks from "../webhooks/webhooks";

const authToken = () => process.env.TYPEFORM_ACCESS_TOKEN ?? "";

describe("typeform.webhooks", async () => {
  test("subscribe", async () => {
    const accessToken = authToken();

    const nockDone = await startNock("typeform.webhook.subscribe");
    try {
      const result = await webhooks.formResponse.subscribe({
        callbackUrl: "https://example.com",
        events: ["form_response"],
        secret: "123456",
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
      expect(result).toMatchInlineSnapshot(`
        {
          "callbackUrl": "https://example.com",
          "data": {
            "created_at": "2023-03-02T13:32:00.154368Z",
            "enabled": true,
            "form_id": "NclFXN1d",
            "id": "01GTH8BG8S4KK1XW38SNDN1SRV",
            "secret": "123456",
            "tag": "myTag",
            "updated_at": "2023-03-02T15:08:01.697884Z",
            "url": "https://example.com",
            "verify_ssl": true,
          },
          "events": [
            "form_response",
          ],
          "headers": {
            "access-control-allow-headers": "X-Typeform-Key, Content-Type, Authorization, Typeform-Version, typeform-app",
            "access-control-allow-methods": "GET, OPTIONS, POST, PUT, PATCH, DELETE",
            "access-control-expose-headers": "Location, X-Request-Id",
            "connection": "close",
            "content-length": "236",
            "content-type": "application/json; charset=UTF-8",
            "date": "Thu, 02 Mar 2023 15:08:01 GMT",
            "server": "istio-envoy",
            "set-cookie": "AWSALBTG=XZsaxHEp0o9b5mG9n0A3X/wO9cNOtnbHMjapJIb1hdKGJ8qN0ifzSuUQKngIMOP77n/x5dT/3Q7pq0zThx8UEAFbt3ViEgrPGAHfvrC1BgSfUZSTPgKF12cM8jkrY7TN9VYzbo2XYq6rO6fUdVmbmaODWu22sXeAXENcKFLf1Vxk; Expires=Thu, 09 Mar 2023 15:08:01 GMT; Path=/, AWSALBTGCORS=XZsaxHEp0o9b5mG9n0A3X/wO9cNOtnbHMjapJIb1hdKGJ8qN0ifzSuUQKngIMOP77n/x5dT/3Q7pq0zThx8UEAFbt3ViEgrPGAHfvrC1BgSfUZSTPgKF12cM8jkrY7TN9VYzbo2XYq6rO6fUdVmbmaODWu22sXeAXENcKFLf1Vxk; Expires=Thu, 09 Mar 2023 15:08:01 GMT; Path=/; SameSite=None; Secure",
            "strict-transport-security": "max-age=63072000; includeSubDomains",
            "x-envoy-upstream-service-time": "14",
          },
          "secret": "super-secret",
          "status": 200,
          "success": true,
        }
      `);
      stopNock(nockDone);
    } catch (e) {
      console.error(e);
      expect(true).toBe(false);
    }
  });
});
