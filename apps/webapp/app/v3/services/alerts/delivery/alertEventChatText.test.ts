import { describe, expect, it } from "vitest";
import { alertEventChatText } from "./alertEventChatText";

const alert = { name: "Queue depth high", capabilityKey: "queue.depth" };
const facts = { value: 142, threshold: 100, unit: "count", windowSec: 300 };

describe("alertEventChatText", () => {
  it("describes a raised event with reading, threshold and window", () => {
    expect(alertEventChatText({ type: "raised", facts }, alert)).toBe(
      "Alert raised: Queue depth high. Queue depth was 142 in the last 5m, threshold 100."
    );
  });

  it("uses recovered wording for a recovered event", () => {
    const text = alertEventChatText({ type: "recovered", facts }, alert);
    expect(text).toMatch(/^Alert recovered: Queue depth high\./);
    expect(text).not.toContain("raised");
  });

  it("formats units and falls back to the capability key without a name", () => {
    const text = alertEventChatText(
      {
        type: "raised",
        facts: { value: 2500, threshold: 1000, unit: "duration_ms", windowSec: 3600 },
      },
      { name: null, capabilityKey: "queue.oldest_age" }
    );
    expect(text).toBe(
      "Alert raised: queue.oldest_age. Oldest queued run age was 2.5s in the last 1h, threshold 1s."
    );
  });

  it("omits the reading when facts carry no numeric value", () => {
    expect(alertEventChatText({ type: "raised", facts: {} }, alert)).toBe(
      "Alert raised: Queue depth high."
    );
  });

  it("names the task and error for a new error group", () => {
    const text = alertEventChatText(
      {
        type: "raised",
        facts: {
          task_identifier: "lightpanda-cdp",
          error_fingerprint: "a0b0310f7c3f238c",
          group_first_seen: "2026-10-15T11:40:12.000Z",
        },
      },
      { name: "New errors", capabilityKey: "errors.new" },
      "Error: connection refused"
    );
    expect(text).toBe(
      "Alert raised: New errors. lightpanda-cdp: Error: connection refused — New error group."
    );
  });

  it("shows occurrences and minute for a recurring error, with fingerprint fallback", () => {
    const text = alertEventChatText(
      {
        type: "raised",
        facts: {
          task_identifier: "sync-inventory",
          error_fingerprint: "744b415906a201cc",
          minute: "2026-10-15T11:40:00.000Z",
          occurrences: 1,
        },
      },
      { name: "Errors again", capabilityKey: "errors.occurred_again" }
    );
    expect(text).toBe(
      "Alert raised: Errors again. sync-inventory · 744b4159 — 1 occurrence at 2026-10-15 11:40 UTC."
    );
  });
});
