import { describe, expect, it } from "vitest";
import {
  EMERGENCY_CAP_NOTICE,
  SESSION_LIMIT_NOTICE,
  sessionBarNotice,
} from "~/components/sessions/v1/trace/sessionRunFallback";
import type { SessionRunLoad } from "~/components/sessions/v1/trace/sessionRunLoads";

const cutOff: SessionRunLoad = {
  state: "cutOff",
  limit: "session",
  started: true,
  spanLimit: 150_000,
  loadId: 1,
};

describe("sessionBarNotice", () => {
  // Catches: runs cut off by the session limit off screen with nothing in the bar to say so.
  it("says the session span limit was reached", () => {
    expect(sessionBarNotice({ deepLink: undefined, view: {}, loads: { run_a: cutOff } })).toBe(
      SESSION_LIMIT_NOTICE
    );
  });

  // Catches: a run's own span limit read as the session's.
  it("ignores runs stopped at their own limit", () => {
    const runLimit: SessionRunLoad = { ...cutOff, limit: "run" };
    expect(
      sessionBarNotice({ deepLink: undefined, view: {}, loads: { run_a: runLimit } })
    ).toBeUndefined();
  });

  // Catches: the cap turned on after the runs page was read, leaving bare "Can't show here" rows.
  it("shows the cap when a first chunk reports it", () => {
    const capped: SessionRunLoad = { state: "unavailable", reason: "emergencyCap", loadId: 2 };
    expect(
      sessionBarNotice({ deepLink: undefined, view: {}, loads: { run_a: capped } })?.text
    ).toBe(EMERGENCY_CAP_NOTICE);
  });

  // Catches: two notices fighting for the one slot.
  it("keeps one notice, most specific first", () => {
    const deepLink = { text: "Couldn't load that run", onRetry: () => {} };
    const view = { run_b: { unavailable: "emergencyCap" } };
    expect(sessionBarNotice({ deepLink, view, loads: { run_a: cutOff } })).toBe(deepLink);
    expect(sessionBarNotice({ deepLink: undefined, view, loads: { run_a: cutOff } })?.text).toBe(
      EMERGENCY_CAP_NOTICE
    );
  });
});
