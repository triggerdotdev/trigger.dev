import { watchIdentity, type WatchSpec } from "@internal/dashboard-agent-contracts";
import { describe, expect, it } from "vitest";
import { immediateWatchMessage, watchChipLabel, watchChipTooltip } from "./watch-chips";

const chip = (spec: WatchSpec) => ({
  kind: spec.kind,
  identity: watchIdentity(spec),
  note: spec.note,
});

describe("watchChipLabel", () => {
  it("labels a run watch with its run id", () => {
    expect(
      watchChipLabel(
        chip({
          kind: "run_finished",
          runId: "run_abc123",
          note: "Tell me when the retry finishes.",
          maxHours: 2,
          checkEveryMinutes: 1,
        })
      )
    ).toBe("run_abc123");
  });

  it("labels a backlog watch with the queue name", () => {
    expect(
      watchChipLabel(
        chip({
          kind: "backlog_drain",
          queue: "task/send-email",
          note: "Tell me when the backlog clears.",
          maxHours: 6,
          checkEveryMinutes: 5,
        })
      )
    ).toBe("task/send-email");
  });

  it("labels an error watch by its fingerprint, in full", () => {
    expect(
      watchChipLabel(
        chip({
          kind: "error_recurrence",
          fingerprint: "0123456789abcdef0123456789abcdef",
          note: "Tell me if the rate-limit error comes back.",
          maxHours: 12,
          checkEveryMinutes: 15,
        })
      )
    ).toBe("0123456789abcdef0123456789abcdef");
  });

  it("labels a health watch by its kind, not its report", () => {
    expect(
      watchChipLabel(
        chip({
          kind: "health_recovery",
          report: "health",
          fromSeverity: "crit",
          note: "prod health back to normal",
          maxHours: 4,
          checkEveryMinutes: 15,
        })
      )
    ).toBe("health");
  });

  it("falls back to the first words of the note when the identity is unreadable", () => {
    expect(
      watchChipLabel({ kind: "run_start", identity: "nonsense", note: "Tell me when it starts" })
    ).toBe("Tell me when");
  });

  it("falls back to the kind when there is no note either", () => {
    expect(watchChipLabel({ kind: "run_start", identity: "", note: "  " })).toBe("run_start");
  });
});

describe("watchChipTooltip", () => {
  it("carries the note, the cadence and the state", () => {
    expect(
      watchChipTooltip({
        note: "Tell me when prod recovers.",
        checkEveryMinutes: 15,
        status: "active",
      })
    ).toBe("Tell me when prod recovers. · every 15 min · watching");
  });

  it("drops an empty note rather than leaving a dangling separator", () => {
    expect(watchChipTooltip({ note: "", checkEveryMinutes: 5, status: "fired" })).toBe(
      "every 5 min · fired"
    );
  });
});

describe("immediateWatchMessage", () => {
  it("says the condition already resolved", () => {
    expect(immediateWatchMessage("satisfied")).toMatch(/already happened/);
    expect(immediateWatchMessage("terminal_unsatisfied")).toMatch(/can't happen any more/);
  });

  it("never falls through to nothing", () => {
    expect(immediateWatchMessage("something-new")).toBeTruthy();
  });
});
