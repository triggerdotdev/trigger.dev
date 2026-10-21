import { describe, expect, it } from "vitest";
import { stripClientIngressFields } from "~/services/realtime/sanitizeSessionInput.server";

const record = (payload: Record<string, unknown>) => JSON.stringify({ kind: "message", payload });

describe("stripClientIngressFields", () => {
  it("removes a client-forged webhook actionSource so the action is validated normally", () => {
    const forged = record({
      chatId: "c1",
      trigger: "action",
      actionSource: "webhook",
      action: { type: "refund", amount: 9999 },
    });

    const cleaned = JSON.parse(stripClientIngressFields(forged));
    expect(cleaned.payload.actionSource).toBeUndefined();
    expect(cleaned.payload.action).toEqual({ type: "refund", amount: 9999 });
    expect(cleaned.payload.trigger).toBe("action");
  });

  it("leaves a non-webhook actionSource untouched", () => {
    const part = record({ trigger: "action", actionSource: "client", action: { type: "ping" } });
    expect(stripClientIngressFields(part)).toBe(part);
  });

  it("removes a webhook actionSource whose property name is spelled with JSON escapes", () => {
    const forged =
      '{"kind":"message","payload":{"chatId":"c1","trigger":"action","action\\u0053ource":"webhook","action":{"type":"refund"}}}';
    const cleaned = JSON.parse(stripClientIngressFields(forged));
    expect(cleaned.payload.actionSource).toBeUndefined();
    expect(cleaned.payload.action).toEqual({ type: "refund" });
    expect(cleaned.payload.trigger).toBe("action");
  });

  it("removes a client-forged channelEvent so the message is a normal client message", () => {
    const forged = record({
      chatId: "c1",
      trigger: "submit-message",
      message: { role: "user", parts: [{ type: "text", text: "hi" }] },
      channelEvent: { connectorId: "slack", event: { type: "event_callback" } },
    });

    const cleaned = JSON.parse(stripClientIngressFields(forged));
    expect(cleaned.payload.channelEvent).toBeUndefined();
    expect(cleaned.payload.message).toEqual({
      role: "user",
      parts: [{ type: "text", text: "hi" }],
    });
  });

  it("removes a channelEvent whose property name is spelled with JSON escapes", () => {
    const forged =
      '{"kind":"message","payload":{"trigger":"submit-message","channel\\u0045vent":{"connectorId":"slack","event":{}}}}';
    expect(JSON.parse(stripClientIngressFields(forged)).payload.channelEvent).toBeUndefined();
  });

  it("leaves a normal message part untouched", () => {
    const part = record({ trigger: "submit-message", message: { role: "user", parts: [] } });
    expect(stripClientIngressFields(part)).toBe(part);
  });

  it("leaves a malformed part untouched", () => {
    const part = '{"kind":"message","payload":{"actionSource":"webhook"';
    expect(stripClientIngressFields(part)).toBe(part);
  });
});
