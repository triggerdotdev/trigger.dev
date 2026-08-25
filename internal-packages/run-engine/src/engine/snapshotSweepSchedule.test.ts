import { describe, expect, it } from "vitest";
import { resolveSnapshotSweepCron } from "./snapshotSweepSchedule.js";

const FALLBACK = "0 */6 * * *";

describe("resolveSnapshotSweepCron", () => {
  it("never schedules without a runner", () => {
    expect(resolveSnapshotSweepCron({ hasRunner: false, fallback: FALLBACK })).toBeUndefined();
    expect(
      resolveSnapshotSweepCron({ hasRunner: false, schedule: "* * * * *", fallback: FALLBACK })
    ).toBeUndefined();
  });

  it("uses the fallback when no schedule is supplied", () => {
    expect(resolveSnapshotSweepCron({ hasRunner: true, fallback: FALLBACK })).toBe(FALLBACK);
  });

  it("uses the supplied schedule", () => {
    expect(
      resolveSnapshotSweepCron({ hasRunner: true, schedule: "0 */12 * * *", fallback: FALLBACK })
    ).toBe("0 */12 * * *");
  });

  it("does not let an empty schedule silently disable the job", () => {
    expect(resolveSnapshotSweepCron({ hasRunner: true, schedule: "", fallback: FALLBACK })).toBe(
      FALLBACK
    );
    expect(resolveSnapshotSweepCron({ hasRunner: true, schedule: "   ", fallback: FALLBACK })).toBe(
      FALLBACK
    );
  });
});

describe("the unconfigured deployment", () => {
  // The webapp must omit the whole options block, not pass a runner that reports unbound: a
  // registered cron would log an unbound pass every interval on every install not using the store.
  it("schedules nothing when the options block is absent", () => {
    expect(
      resolveSnapshotSweepCron({ hasRunner: false, schedule: "0 */6 * * *", fallback: FALLBACK })
    ).toBeUndefined();
  });
});
