import { stringifyIO } from "@trigger.dev/core/v3";
import { describe, expect, it } from "vitest";
import { getScheduleTaskRunPayload } from "~/presenters/v3/TestTaskPresenter.server";

const baseSchedulePayload = () => ({
  scheduleId: "sched_abc123",
  type: "IMPERATIVE" as const,
  timestamp: new Date("2026-05-01T12:00:00.000Z"),
  upcoming: [
    new Date("2026-05-02T12:00:00.000Z"),
    new Date("2026-05-03T12:00:00.000Z"),
  ],
});

describe("getScheduleTaskRunPayload", () => {
  it("returns failure (does not throw) when the payload data is empty — regression for TRIGGER-CLOUD-1AG", async () => {
    const result = await getScheduleTaskRunPayload("", "application/json");
    expect(result.success).toBe(false);
  });

  it("parses a valid scheduled payload and preserves the supplied timezone", async () => {
    const packet = await stringifyIO({
      ...baseSchedulePayload(),
      timezone: "Europe/London",
    });

    const result = await getScheduleTaskRunPayload(packet.data!, packet.dataType);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("Europe/London");
      expect(result.data.scheduleId).toBe("sched_abc123");
    }
  });

  it("defaults timezone to UTC when the parsed packet has no timezone field", async () => {
    const packet = await stringifyIO(baseSchedulePayload());

    const result = await getScheduleTaskRunPayload(packet.data!, packet.dataType);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("UTC");
    }
  });

  it("defaults timezone to UTC when the parsed packet has an empty-string timezone", async () => {
    const packet = await stringifyIO({
      ...baseSchedulePayload(),
      timezone: "",
    });

    const result = await getScheduleTaskRunPayload(packet.data!, packet.dataType);

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.timezone).toBe("UTC");
    }
  });

  it("returns failure when the parsed packet does not match the ScheduledTaskPayload shape", async () => {
    const packet = await stringifyIO({ unrelated: "value" });

    const result = await getScheduleTaskRunPayload(packet.data!, packet.dataType);

    expect(result.success).toBe(false);
  });
});
