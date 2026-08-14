import { describe, it } from "vitest";
import { create, task, update } from "./index.js";

declare const runtimeWindow: string;

function assertDeclarativeScheduleWindowTypes() {
  task({
    id: "valid-window",
    cron: { pattern: "*/5 * * * *", window: "30m" },
    run: async () => undefined,
  });
  task({
    id: "runtime-window",
    cron: { pattern: "*/5 * * * *", window: runtimeWindow },
    run: async () => undefined,
  });

  task({
    id: "duration-too-large",
    // @ts-expect-error Schedule windows cannot exceed 24 hours.
    cron: { pattern: "*/5 * * * *", window: "25h" },
    run: async () => undefined,
  });
  task({
    id: "percentage-too-large",
    // @ts-expect-error Schedule window percentages cannot exceed 100%.
    cron: { pattern: "*/5 * * * *", window: "101%" },
    run: async () => undefined,
  });
  task({
    id: "unsupported-unit",
    // @ts-expect-error Days are not a supported schedule-window unit.
    cron: { pattern: "*/5 * * * *", window: "1d" },
    run: async () => undefined,
  });
  task({
    id: "fractional-window",
    // @ts-expect-error Schedule windows must use whole numbers.
    cron: { pattern: "*/5 * * * *", window: "1.5m" },
    run: async () => undefined,
  });
  task({
    id: "negative-window",
    // @ts-expect-error Schedule windows must be non-negative.
    cron: { pattern: "*/5 * * * *", window: "-1m" },
    run: async () => undefined,
  });
  task({
    id: "leading-zero-window",
    // @ts-expect-error Schedule windows must use canonical whole numbers.
    cron: { pattern: "*/5 * * * *", window: "01m" },
    run: async () => undefined,
  });
}

function assertImperativeScheduleWindowTypes() {
  create({
    task: "scheduled-task",
    cron: "*/5 * * * *",
    deduplicationKey: "valid",
    window: "50%",
  });
  create({
    task: "scheduled-task",
    cron: "*/5 * * * *",
    deduplicationKey: "runtime",
    window: runtimeWindow,
  });
  update("schedule_123", {
    task: "scheduled-task",
    cron: "*/5 * * * *",
    window: "1440m",
  });

  create({
    task: "scheduled-task",
    cron: "*/5 * * * *",
    deduplicationKey: "invalid",
    // @ts-expect-error Schedule windows cannot exceed 24 hours.
    window: "1441m",
  });
  update("schedule_123", {
    task: "scheduled-task",
    cron: "*/5 * * * *",
    // @ts-expect-error Schedule windows must use a supported unit.
    window: "30s",
  });
}

describe("schedule window types", () => {
  it("validates declarative schedule literals", () => {
    void assertDeclarativeScheduleWindowTypes;
  });

  it("validates imperative schedule literals", () => {
    void assertImperativeScheduleWindowTypes;
  });
});
