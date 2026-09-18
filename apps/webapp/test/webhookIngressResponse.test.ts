import { describe, expect, it } from "vitest";
import { toWebhookHttpResponse, webhookHttpResponseFor } from "~/v3/webhookIngressResponse.server";

describe("webhook ingress HTTP contract", () => {
  it("answers a bodiless 204 handshake with a content type and no body", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({ outcome: "handshake", status: 204, body: "" })
    );
    expect(res.status).toBe(204);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.text()).toBe("");
  });

  it("echoes a 200 handshake challenge as text", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({ outcome: "handshake", status: 200, body: "chal_xyz" })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("text/plain");
    expect(await res.text()).toBe("chal_xyz");
  });

  it("acknowledges an accepted delivery with the declared status and no body", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({
        outcome: "accepted",
        deliveryId: "d_1",
        deliveryFriendlyId: "whdel_1",
        response: { acceptedStatus: 204, rejectedStatus: 401 },
      })
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("keeps the default 200 JSON acknowledgement when no contract is declared", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({
        outcome: "accepted",
        deliveryId: "d_1",
        deliveryFriendlyId: "whdel_1",
      })
    );
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(await res.json()).toEqual({ received: true, deliveryId: "whdel_1" });
  });

  it("acknowledges a duplicate with the declared status and no extra body", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({
        outcome: "duplicate",
        deliveryId: "whdel_1",
        response: { acceptedStatus: 204 },
      })
    );
    expect(res.status).toBe(204);
    expect(await res.text()).toBe("");
  });

  it("rejects a bad signature with the declared status, default 400", async () => {
    const declared = toWebhookHttpResponse(
      webhookHttpResponseFor({
        outcome: "verification_failed",
        error: "signature mismatch",
        response: { rejectedStatus: 401 },
      })
    );
    expect(declared.status).toBe(401);
    expect(await declared.json()).toEqual({ error: "Bad request" });

    const fallback = webhookHttpResponseFor({
      outcome: "verification_failed",
      error: "signature mismatch",
    });
    expect(fallback.status).toBe(400);
  });

  it("answers 405 with Allow: POST when the source declares no GET handshake", async () => {
    const res = toWebhookHttpResponse(webhookHttpResponseFor({ outcome: "method_not_allowed" }));
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("POST");
    expect(res.headers.get("content-type")).toBe("application/json");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });

  it("advertises GET and HEAD alongside POST for verification endpoints", async () => {
    const res = toWebhookHttpResponse(
      webhookHttpResponseFor({
        outcome: "method_not_allowed",
        allowedMethods: ["GET", "HEAD", "POST"],
      })
    );
    expect(res.status).toBe(405);
    expect(res.headers.get("allow")).toBe("GET, HEAD, POST");
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(await res.json()).toEqual({ error: "Method not allowed" });
  });

  it.each([400, 401, 403] as const)(
    "uses the declared %i status for missing credentials",
    async (status) => {
      const res = toWebhookHttpResponse(
        webhookHttpResponseFor({
          outcome: "secret_missing",
          response: { rejectedStatus: status },
        })
      );
      expect(res.status).toBe(status);
      expect(await res.json()).toEqual({ error: "Bad request" });
    }
  );

  it("maps the remaining outcomes to their statuses", () => {
    expect(webhookHttpResponseFor({ outcome: "endpoint_not_found" }).status).toBe(404);
    expect(webhookHttpResponseFor({ outcome: "endpoint_inactive" }).status).toBe(404);
    expect(webhookHttpResponseFor({ outcome: "secret_missing" }).status).toBe(400);
    expect(webhookHttpResponseFor({ outcome: "enqueue_failed", error: "x" }).status).toBe(500);
  });

  it("gives the dashboard test-send the same answer as the public ingress", () => {
    expect(
      webhookHttpResponseFor({
        outcome: "accepted",
        deliveryId: "d_1",
        deliveryFriendlyId: "whdel_1",
        response: { acceptedStatus: 204 },
      })
    ).toEqual({ status: 204, body: null, contentType: "application/json" });
    expect(webhookHttpResponseFor({ outcome: "handshake", status: 204, body: "" })).toEqual({
      status: 204,
      body: null,
      contentType: "text/plain",
    });
  });
});
