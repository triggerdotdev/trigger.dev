import { describe, it, expect } from "vitest";
import superjson from "superjson";
import { getScheduleTaskRunPayload } from "../app/presenters/v3/getScheduleTaskRunPayload.server";

describe("getScheduleTaskRunPayload", () => {
  it("should return failure when payload is empty", async () => {
    const result = await getScheduleTaskRunPayload("", "application/json");

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error).toBeDefined();
    }
  });

  it("should parse a valid scheduled payload", async () => {
    const now = new Date();
    const result = await getScheduleTaskRunPayload(
      superjson.stringify({
        scheduleId: "sch_123",
        type: "DECLARATIVE",
        timestamp: now,
        timezone: "UTC",
        upcoming: [now],
      }),
      "application/super+json"
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.scheduleId).toBe("sch_123");
      expect(result.data.type).toBe("DECLARATIVE");
      expect(result.data.timezone).toBe("UTC");
      expect(result.data.upcoming.length).toBe(1);
      expect(result.data.timestamp).toBeInstanceOf(Date);
    }
  });

  it("should return failure for invalid JSON", async () => {
    const result = await getScheduleTaskRunPayload("{invalid", "application/json");

    expect(result.success).toBe(false);
  });
});

