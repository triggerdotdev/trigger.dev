import { describe, expect, it, vi } from "vitest";
import { redisTest } from "@internal/testcontainers";
import { MollifierBuffer } from "@trigger.dev/redis-worker";

vi.mock("~/db.server", () => ({ prisma: {}, $replica: {} }));

import { runStaleSweepOnce } from "~/v3/mollifier/mollifierStaleSweep.server";

const SNAPSHOT = {
  taskIdentifier: "hello-world",
  payload: '{"x":1}',
  payloadType: "application/json",
  traceContext: {},
};

function spyDeps() {
  const recordedStaleEnvIds: string[] = [];
  const snapshots: Array<Map<string, number>> = [];
  const warnings: Array<{ message: string; fields: Record<string, unknown> }> = [];
  return {
    recordedStaleEnvIds,
    snapshots,
    warnings,
    deps: {
      recordStaleEntry: (envId: string) => {
        recordedStaleEnvIds.push(envId);
      },
      reportStaleEntrySnapshot: (snapshot: Map<string, number>) => {
        // Clone so post-sweep assertions see what was reported *at that
        // call site*, not whatever subsequent passes mutate the source
        // map into.
        snapshots.push(new Map(snapshot));
      },
      logger: {
        warn: (message: string, fields: Record<string, unknown>) => {
          warnings.push({ message, fields });
        },
      },
    },
  };
}

describe("runStaleSweepOnce — unit", () => {
  it("returns zeros when the buffer is null", async () => {
    // Mirrors the prod gate: if TRIGGER_MOLLIFIER_ENABLED=0 the buffer
    // singleton is null and the sweep is a no-op. We don't want it to
    // emit a metric (or throw) just because mollifier is disabled.
    const { deps, recordedStaleEnvIds, warnings, snapshots } = spyDeps();
    const result = await runStaleSweepOnce(
      { staleThresholdMs: 1000 },
      { ...deps, getBuffer: () => null },
    );
    expect(result).toEqual({
      orgsScanned: 0,
      envsScanned: 0,
      entriesScanned: 0,
      staleCount: 0,
    });
    expect(recordedStaleEnvIds).toEqual([]);
    expect(warnings).toEqual([]);
    // An empty snapshot is still reported so any previously-paging env
    // (from a prior sweep before mollifier was disabled) clears.
    expect(snapshots).toHaveLength(1);
    expect(snapshots[0].size).toBe(0);
  });
});

describe("runStaleSweepOnce — testcontainers", () => {
  redisTest(
    "flags entries whose dwell exceeds the stale threshold and skips fresh ones",
    async ({ redisOptions }) => {
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        // Two stale entries (one in each env) + one fresh entry. Sweep
        // should flag the two stale, leave the fresh one alone, record
        // the counter once per stale entry, and emit a warning per
        // stale entry with the dwell + threshold.
        await buffer.accept({
          runId: "run_stale_a",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_stale_b",
          envId: "env_b",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_fresh",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        // Yank the system clock forward 5 minutes for the sweep — way
        // past the threshold below. The `now` deps seam lets us drive
        // the threshold without actually waiting in real time.
        const futureNow = Date.now() + 5 * 60 * 1000;

        const { deps, recordedStaleEnvIds, warnings, snapshots } = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          {
            ...deps,
            getBuffer: () => buffer,
            now: () => futureNow,
          },
        );

        expect(result.envsScanned).toBe(2);
        expect(result.entriesScanned).toBe(3);
        expect(result.staleCount).toBe(3);
        // All three entries have dwell ~5min, all exceed the 1-min
        // threshold; each emits one counter tick + one warning.
        expect(recordedStaleEnvIds.sort()).toEqual(
          ["env_a", "env_a", "env_b"].sort(),
        );
        expect(warnings).toHaveLength(3);
        for (const w of warnings) {
          expect(w.message).toBe("mollifier.stale_entry");
          expect(w.fields.staleThresholdMs).toBe(60 * 1000);
          expect(w.fields.dwellMs).toBeGreaterThan(60 * 1000);
        }
        // Snapshot drives the alertable gauge — env_a has 2 stale
        // entries, env_b has 1. Both must appear so a future alert can
        // identify which env is paging.
        expect(snapshots).toHaveLength(1);
        expect(Object.fromEntries(snapshots[0])).toEqual({
          env_a: 2,
          env_b: 1,
        });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "snapshot reports zero for envs that have entries but none stale (clears latched alerts)",
    async ({ redisOptions }) => {
      // Critical for alert behaviour: a previous sweep reported env_a
      // stale, alert fired, drainer caught up. The next sweep must
      // report `env_a -> 0` so the gauge drops below the alert
      // threshold instead of staying latched at the last stale value.
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_just_arrived",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        const { deps, snapshots } = spyDeps();
        await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...deps, getBuffer: () => buffer },
        );
        expect(snapshots).toHaveLength(1);
        expect(Object.fromEntries(snapshots[0])).toEqual({ env_a: 0 });
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "leaves fresh entries alone (dwell below threshold)",
    async ({ redisOptions }) => {
      // Regression guard for the inequality direction. A bug that flipped
      // `dwellMs > threshold` to `dwellMs >= threshold` would flag every
      // entry the first time the sweep runs after a perfectly synchronised
      // accept call — the dashboard would page on every burst.
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_fresh_only",
          envId: "env_a",
          orgId: "org_1",
          payload: JSON.stringify(SNAPSHOT),
        });
        const { deps, recordedStaleEnvIds, warnings } = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...deps, getBuffer: () => buffer },
        );
        expect(result.staleCount).toBe(0);
        expect(recordedStaleEnvIds).toEqual([]);
        expect(warnings).toEqual([]);
      } finally {
        await buffer.close();
      }
    },
  );

  redisTest(
    "scans across multiple orgs",
    async ({ redisOptions }) => {
      // Phase-3 design has org-level fairness in the drainer; the sweep
      // must walk every org/env, not just the first one it finds. If a
      // future refactor collapsed listOrgs/listEnvsForOrg into a single
      // env-flat list this test catches a regression there.
      const buffer = new MollifierBuffer({ redisOptions });
      try {
        await buffer.accept({
          runId: "run_x",
          envId: "env_x",
          orgId: "org_x",
          payload: JSON.stringify(SNAPSHOT),
        });
        await buffer.accept({
          runId: "run_y",
          envId: "env_y",
          orgId: "org_y",
          payload: JSON.stringify(SNAPSHOT),
        });
        const futureNow = Date.now() + 5 * 60 * 1000;
        const { deps } = spyDeps();
        const result = await runStaleSweepOnce(
          { staleThresholdMs: 60 * 1000 },
          { ...deps, getBuffer: () => buffer, now: () => futureNow },
        );
        expect(result.orgsScanned).toBe(2);
        expect(result.envsScanned).toBe(2);
        expect(result.staleCount).toBe(2);
      } finally {
        await buffer.close();
      }
    },
  );
});
