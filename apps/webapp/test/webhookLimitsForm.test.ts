import { describe, expect, it } from "vitest";
import {
  parseWebhookLimitsForm,
  WEBHOOK_LIMITS_INTENT,
} from "../app/components/admin/backOffice/WebhookLimitsForm.js";

function form(fields: Record<string, string>) {
  const data = new FormData();
  data.set("intent", WEBHOOK_LIMITS_INTENT);
  for (const [key, value] of Object.entries(fields)) data.set(key, value);
  return data;
}

describe("parseWebhookLimitsForm", () => {
  it("accepts a queued payload limit above 2 GiB", () => {
    const parsed = parseWebhookLimitsForm(form({ queuedPayloadBytes: String(4 * 1024 ** 3) }));
    expect(parsed.success && parsed.data.queuedPayloadBytes).toBe(4 * 1024 ** 3);
  });

  it("still caps count limits at a 32-bit integer", () => {
    expect(parseWebhookLimitsForm(form({ concurrency: String(4 * 1024 ** 3) })).success).toBe(
      false
    );
  });

  it("leaves a blank field unset", () => {
    const parsed = parseWebhookLimitsForm(form({ queuedPayloadBytes: "" }));
    expect(parsed.success && parsed.data.queuedPayloadBytes).toBeUndefined();
  });
});
