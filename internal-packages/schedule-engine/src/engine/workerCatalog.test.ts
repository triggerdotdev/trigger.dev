import { describe, expect, it } from "vitest";
import { scheduleWorkerCatalog } from "./workerCatalog.js";

const schema = scheduleWorkerCatalog["schedule.triggerScheduledTask"].schema;

describe("scheduleWorkerCatalog", () => {
  it("accepts legacy payloads without an effective schedule time", () => {
    const exactScheduleTime = "2026-08-11T10:00:00.000Z";

    const payload = schema.parse({
      instanceId: "instance_123",
      exactScheduleTime,
    });

    expect(payload.exactScheduleTime).toEqual(new Date(exactScheduleTime));
    expect(payload.effectiveScheduleTime).toBeUndefined();
  });

  it("coerces nominal and effective schedule times for new payloads", () => {
    const exactScheduleTime = "2026-08-11T10:00:00.000Z";
    const effectiveScheduleTime = "2026-08-11T10:00:42.123Z";

    const payload = schema.parse({
      instanceId: "instance_123",
      exactScheduleTime,
      effectiveScheduleTime,
    });

    expect(payload.exactScheduleTime).toEqual(new Date(exactScheduleTime));
    expect(payload.effectiveScheduleTime).toEqual(new Date(effectiveScheduleTime));
  });
});
