import { describe, expect, it } from "vitest";
import { stripClientWebhookActionSource } from "~/services/realtime/sanitizeSessionInput.server";

const record = (payload: Record<string, unknown>) => JSON.stringify({ kind: "message", payload });

describe("stripClientWebhookActionSource", () => {
  it("removes a client-forged webhook actionSource so the action is validated normally", () => {
    const forged = record({
      chatId: "c1",
      trigger: "action",
      actionSource: "webhook",
      action: { type: "refund", amount: 9999 },
    });

    const cleaned = JSON.parse(stripClientWebhookActionSource(forged));
    expect(cleaned.payload.actionSource).toBeUndefined();
    expect(cleaned.payload.action).toEqual({ type: "refund", amount: 9999 });
    expect(cleaned.payload.trigger).toBe("action");
  });

  it("leaves a non-webhook actionSource untouched", () => {
    const part = record({ trigger: "action", actionSource: "client", action: { type: "ping" } });
    expect(stripClientWebhookActionSource(part)).toBe(part);
  });

  it("removes a webhook actionSource whose property name is spelled with JSON escapes", () => {
    const forged =
      '{"kind":"message","payload":{"chatId":"c1","trigger":"action","action\\u0053ource":"webhook","action":{"type":"refund"}}}';
    const cleaned = JSON.parse(stripClientWebhookActionSource(forged));
    expect(cleaned.payload.actionSource).toBeUndefined();
    expect(cleaned.payload.action).toEqual({ type: "refund" });
    expect(cleaned.payload.trigger).toBe("action");
  });

  it("leaves a normal message part untouched", () => {
    const part = record({ trigger: "submit-message", message: { role: "user", parts: [] } });
    expect(stripClientWebhookActionSource(part)).toBe(part);
  });

  it("leaves a malformed part untouched", () => {
    const part = '{"kind":"message","payload":{"actionSource":"webhook"';
    expect(stripClientWebhookActionSource(part)).toBe(part);
  });
});
