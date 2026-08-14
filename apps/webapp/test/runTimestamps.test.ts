import { describe, expect, it } from "vitest";
import { runTriggeredAt } from "~/v3/runTimestamps";

describe("runTriggeredAt", () => {
  const createdAt = new Date("2026-08-14T08:30:00.000Z");
  const queueTimestamp = new Date("2026-08-14T08:38:25.000Z");

  it("uses the effective queue timestamp for scheduled runs", () => {
    expect(
      runTriggeredAt({
        createdAt,
        queueTimestamp,
        scheduleId: "schedule_123",
      })
    ).toEqual(queueTimestamp);
  });

  it("preserves the creation time for non-scheduled delayed runs", () => {
    expect(
      runTriggeredAt({
        createdAt,
        queueTimestamp,
        scheduleId: null,
      })
    ).toEqual(createdAt);
  });

  it("falls back to the creation time when a scheduled run has no queue timestamp", () => {
    expect(
      runTriggeredAt({
        createdAt,
        queueTimestamp: null,
        scheduleId: "schedule_123",
      })
    ).toEqual(createdAt);
  });
});
