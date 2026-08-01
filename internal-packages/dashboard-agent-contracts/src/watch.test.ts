import { describe, expect, it } from "vitest";
import {
  WATCH_KINDS,
  watchCheckResultSchema,
  watchDeliveryStatusSchema,
  watchIdentity,
  watchSpecSchema,
  watchStatusSchema,
  type WatchSpec,
} from "./watch.js";

const common = { maxHours: 6, note: "because I asked" };

const specs = {
  run_start: { ...common, kind: "run_start", runId: "run_123", checkEveryMinutes: 1 },
  run_finished: { ...common, kind: "run_finished", runId: "run_x", checkEveryMinutes: 5 },
  backlog_drain: { ...common, kind: "backlog_drain", queue: "email-sends", checkEveryMinutes: 5 },
  error_recurrence: {
    ...common,
    kind: "error_recurrence",
    fingerprint: "a1b2c3",
    checkEveryMinutes: 15,
  },
  health_recovery: {
    ...common,
    kind: "health_recovery",
    report: "health",
    fromSeverity: "warn",
    checkEveryMinutes: 60,
  },
} satisfies Record<string, WatchSpec>;

describe("watchSpecSchema", () => {
  it("accepts every kind", () => {
    for (const spec of Object.values(specs)) {
      expect(watchSpecSchema.safeParse(spec).success).toBe(true);
    }
  });

  it("allows a 1-minute cadence for run-state watches", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_finished, checkEveryMinutes: 1 }).success).toBe(
      true
    );
  });

  it("rejects a 1-minute cadence for aggregate watches", () => {
    expect(
      watchSpecSchema.safeParse({ ...specs.backlog_drain, checkEveryMinutes: 1 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.error_recurrence, checkEveryMinutes: 1 }).success
    ).toBe(false);
    expect(
      watchSpecSchema.safeParse({ ...specs.health_recovery, checkEveryMinutes: 1 }).success
    ).toBe(false);
  });

  it("rejects an off-grid cadence", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_start, checkEveryMinutes: 3 }).success).toBe(
      false
    );
    expect(
      watchSpecSchema.safeParse({ ...specs.backlog_drain, checkEveryMinutes: 30 }).success
    ).toBe(false);
  });

  it("enforces the 24 hour ceiling", () => {
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 24 }).success).toBe(true);
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 25 }).success).toBe(false);
    expect(watchSpecSchema.safeParse({ ...specs.run_start, maxHours: 0 }).success).toBe(false);
  });

  it("requires a note", () => {
    const { note, ...withoutNote } = specs.run_start;
    expect(watchSpecSchema.safeParse(withoutNote).success).toBe(false);
  });

  it("does not accept a client-supplied `since` on error_recurrence", () => {
    const parsed = watchSpecSchema.parse({
      ...specs.error_recurrence,
      since: "2026-01-01T00:00:00.000Z",
    });
    expect(parsed).not.toHaveProperty("since");
  });

  it("rejects an unknown kind", () => {
    expect(watchSpecSchema.safeParse({ ...common, kind: "run_slow", runId: "run_1" }).success).toBe(
      false
    );
  });
});

describe("watchIdentity", () => {
  it("identifies the condition, not the cadence", () => {
    expect(watchIdentity(specs.run_start)).toBe("run_start:run_123");
    expect(watchIdentity(specs.run_finished)).toBe("run_finished:run_x");
    expect(watchIdentity(specs.backlog_drain)).toBe("backlog_drain:email-sends");
    expect(watchIdentity(specs.error_recurrence)).toBe("error_recurrence:a1b2c3");
    expect(watchIdentity(specs.health_recovery)).toBe("health_recovery:health");
  });

  it("ignores cadence, note, and maxHours", () => {
    expect(
      watchIdentity({
        ...specs.backlog_drain,
        checkEveryMinutes: 60,
        note: "different",
        maxHours: 1,
      })
    ).toBe(watchIdentity(specs.backlog_drain));
  });

  it("covers every kind exhaustively", () => {
    for (const kind of WATCH_KINDS) {
      expect(watchIdentity(specs[kind])).toContain(`${kind}:`);
    }
  });
});

// Compile-time exhaustiveness: adding a WatchSpec variant breaks this switch.
function describeWatch(spec: WatchSpec): string {
  switch (spec.kind) {
    case "run_start":
      return `start of ${spec.runId}`;
    case "run_finished":
      return `finish of ${spec.runId}`;
    case "backlog_drain":
      return `drain of ${spec.queue}`;
    case "error_recurrence":
      return `recurrence of ${spec.fingerprint}`;
    case "health_recovery":
      return `recovery from ${spec.fromSeverity}`;
    default: {
      const unreachable: never = spec;
      throw new Error(`Unhandled: ${JSON.stringify(unreachable)}`);
    }
  }
}

describe("exhaustiveness", () => {
  it("handles all five kinds", () => {
    expect(Object.values(specs).map(describeWatch)).toHaveLength(5);
    expect(WATCH_KINDS).toHaveLength(5);
  });
});

describe("enums", () => {
  it("check results", () => {
    expect(watchCheckResultSchema.options).toEqual([
      "pending",
      "satisfied",
      "terminal_unsatisfied",
      "unavailable",
    ]);
  });

  it("statuses", () => {
    expect(watchStatusSchema.options).toEqual(["active", "fired", "expired", "cancelled"]);
    expect(watchDeliveryStatusSchema.options).toEqual(["not_required", "pending", "delivered"]);
  });
});
