import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import {
  DEFAULT_SNAPSHOT_SWEEP_BUDGET_MS,
  resolveSnapshotSweepCron,
  seedSnapshotSweepOutcomes,
  SNAPSHOT_SWEEP_SEEDED_OUTCOMES,
  snapshotSweepVisibilityTimeoutMs,
} from "./snapshotSweepSchedule.js";

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

describe("snapshotSweepVisibilityTimeoutMs", () => {
  // The runner's lock TTL is the budget plus an hour. The delivery window has to stay above it, or
  // a redelivery arrives while the previous pass still holds the fence.
  const lockTtl = (budget: number) => budget + 60 * 60 * 1000;

  it("stays above the lock TTL at the default budget", () => {
    expect(snapshotSweepVisibilityTimeoutMs()).toBeGreaterThan(
      lockTtl(DEFAULT_SNAPSHOT_SWEEP_BUDGET_MS)
    );
  });

  it("stays above the lock TTL for a raised budget", () => {
    for (const budget of [60_000, 10_800_000, 43_200_000, 86_400_000]) {
      expect(snapshotSweepVisibilityTimeoutMs(budget)).toBeGreaterThan(lockTtl(budget));
    }
  });
});

describe("seeding the sweep outcome series", () => {
  it("creates each seeded outcome at zero", () => {
    // `sum(increase(...)) == 0` matches NOTHING when the series is absent, so an alert asking "no
    // completed passes in 24h" cannot fire on a sweep that has never run. Seeding at zero is what
    // makes that absence visible.
    const added: { value: number; attributes: Record<string, string> }[] = [];
    seedSnapshotSweepOutcomes({
      add: (value, attributes) => added.push({ value, attributes }),
    });

    expect(added).toEqual([{ value: 0, attributes: { outcome: "completed" } }]);
  });

  it("seeds every outcome the alerting rules query, or the alert cannot fire", () => {
    // The invariant that ties the two together: an outcome an alert filters on must be seeded.
    // Without this, removing the seed OR changing the alert's outcome silently disables the alert.
    const rules = readFileSync(
      resolve(__dirname, "../../../../docker/config/alerts/snapshot-store.yml"),
      "utf8"
    );
    const sweepRule = rules.slice(rules.indexOf("- alert: SnapshotStoreSweepNotCompleting"));
    const queried = [...sweepRule.matchAll(/sweep_pass_total[^}]*outcome="([a-z]+)"/g)].map(
      (m) => m[1]
    );

    expect(queried.length).toBeGreaterThan(0);
    for (const outcome of queried) {
      expect(SNAPSHOT_SWEEP_SEEDED_OUTCOMES).toContain(outcome);
    }
  });
});
